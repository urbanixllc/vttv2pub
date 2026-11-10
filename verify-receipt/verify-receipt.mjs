#!/usr/bin/env node
/**
 * VesTally for Business receipt verifier: FairSelect and RecordProof, with no VesTally servers.
 *
 *   node verify-receipt.mjs <receipt.json> [files or folders…] --rpc <BNB Chain RPC URL> [--submitter <address>]
 *
 *   npm install            (once; the only dependency is viem, for keccak-256 and ABI encoding)
 *
 * FairSelect (.fairselect.json):
 *  1. The rules are valid, and the lock value equals the Fair draw formula over
 *     entriesCode = population root, salt = keccak(abi.encode(SELECT_DOMAIN, sha256(canonical rules), nonce)).
 *  2. The lock's record is a RecordAnchor transaction from VesTally's relayer (../verify-proof.mjs).
 *  3. The random block is the lock's block + 100, read from the chain: its hash must match the receipt.
 *  4. The Ledger beacon recomputes from its secret and witness reveals (each reveal links back by
 *     repeated hashing). With no reveals, the Ledger part rests on VesTally alone: a warning.
 *  5. The sample = pickWinners(value, keccak(blockHash ‖ beacon), N, k) and matches the receipt.
 *  6. Each disclosed member sits at its locked position (salted leaf + Merkle path → population root).
 *
 * RecordProof (.recordproof.json):
 *  1. The receipt's files make up its set code (full receipt: rebuild from the secret; one-file
 *     receipt: the disclosed path).
 *  2. Each file given matches a file in the receipt by SHA-256 (changed, extra and missing files are named).
 *  3. The set code's record is a RecordAnchor transaction from VesTally's relayer.
 *
 * What a pass means: see each product's note. Integrity and order in time, never truth, authorship
 * or legal validity; a FairSelect population is the organizer's own statement.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { concat, encodeAbiParameters, getAddress, keccak256, stringToBytes } from "viem";
import { verify as verifyProof } from "../verify-proof.mjs";

const d = (s) => keccak256(stringToBytes(s));
export const DOMAINS = {
  fairselect: { member: d("vestally-fairselect-member-v1"), salt: d("vestally-fairselect-member-salt-v1") },
  recordproof: { member: d("vestally-recordproof-file-v1"), salt: d("vestally-recordproof-file-salt-v1") },
  selection: d("vestally-fairselect-salt-v1"),
  beaconV1: d("VesTally Blockchain Ledger beacon v1"),
  beaconV2: d("VesTally Blockchain Ledger beacon v2"),
};
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const lc = (h) => String(h).toLowerCase();
const sha256 = (bytes) => "0x" + createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------- shared formulas (packages/chain)

/** Fair draw normalization: invisible characters removed, runs of spaces collapsed, trimmed. */
export function normalizeEntry(line) {
  return line
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export const memberHash = (m) => sha256(Buffer.from(normalizeEntry(m), "utf8"));

/** JSON with sorted keys and no spaces (whole numbers only), as packages/chain council.ts. */
export function canonicalJson(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("Canonical JSON here only holds whole numbers.");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  throw new Error(`Can't put a ${typeof v} in canonical JSON.`);
}

export const itemSalt = (dom, secret, i) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [dom.salt, secret, BigInt(i)]));
export const itemLeaf = (dom, i, salt, h) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }], [dom.member, BigInt(i), salt, h]));
const pair = (a, b) => (lc(a) < lc(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export function merkleRoot(leaves) {
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(level[i + 1] ? pair(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return lc(level[0]);
}
export const walkPath = (leaf, path) => lc(path.reduce((h, p) => pair(h, p), leaf));

export function drawValueBeacon(t) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint32" }, { type: "uint32" }, { type: "bytes32" }, { type: "string" }],
      [t.entriesCode, t.entryCount, t.winnerCount, t.salt, "ledger-beacon-v1"],
    ),
  );
}
export const selectionSalt = (rulesHash, nonce) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [DOMAINS.selection, rulesHash, nonce]));
export const rulesHash = (rules) => sha256(Buffer.from(canonicalJson(rules), "utf8"));
export const drawRandomness = (blockHash, beacon) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [blockHash, beacon]));

export function pickWinners(value, seed, n, k) {
  const chosen = new Set();
  const out = [];
  for (let nonce = 0; out.length < k; nonce++) {
    const r = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [value, seed, BigInt(nonce)])));
    const index = Number(r % BigInt(n));
    if (chosen.has(index)) continue;
    chosen.add(index);
    out.push(index);
  }
  return out;
}

/** Recomputes a closed beacon (beacon.ts beaconValue) and checks every reveal links to the one before. */
export function checkBeacon(b) {
  if (!b || !HEX32.test(b.blockHash) || !HEX32.test(b.value) || !Array.isArray(b.reveals)) return "The beacon is malformed.";
  const seen = new Set();
  for (const r of b.reveals) {
    if (seen.has(lc(r.witness))) return "A witness appears twice in the beacon.";
    seen.add(lc(r.witness));
    const steps = r.index - r.prev.index;
    if (!Number.isInteger(steps) || steps < 1 || steps > 10_000) return "A reveal doesn't follow its witness's previous one.";
    let v = r.value;
    for (let i = 0; i < steps; i++) v = keccak256(v);
    if (lc(v) !== lc(r.prev.value)) return "A reveal doesn't hash back to its witness's previous one.";
  }
  const s = [...b.reveals].sort((x, y) => (lc(x.witness) < lc(y.witness) ? -1 : 1));
  const list = [s.map((x) => getAddress(x.witness)), s.map((x) => BigInt(x.index)), s.map((x) => x.value)];
  const value =
    b.secret === undefined
      ? keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "address[]" }, { type: "uint64[]" }, { type: "bytes32[]" }], [DOMAINS.beaconV1, BigInt(b.height), b.blockHash, ...list]))
      : keccak256(
          encodeAbiParameters(
            [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address[]" }, { type: "uint64[]" }, { type: "bytes32[]" }],
            [DOMAINS.beaconV2, BigInt(b.height), b.blockHash, b.secret, ...list],
          ),
        );
  return lc(value) === lc(b.value) ? null : "The beacon's value doesn't match its reveals.";
}

async function rpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** [ok, message] lines, where ok is true, false or "warn". */
async function anchorLines(proof, code, kind, rpcUrl, submitter) {
  if (!proof) return [["warn", "No BNB Chain record in the receipt yet (it was made before the daily record). Ask for an updated receipt."]];
  if (lc(proof.code) !== lc(code) || Number(proof.leafKind ?? 1) !== kind) return [[false, "The record in the receipt is for something else."]];
  const lines = await verifyProof(proof, null, rpcUrl, { submitter });
  return lines.filter(([, m]) => !m.startsWith("No file given"));
}

// ---------------------------------------------------------------- FairSelect

export async function verifySelection(r, rpcUrl, opts = {}) {
  const out = [];
  const R = r.rules ?? {};
  const okRules =
    R.spec === "vestally-fairselect-rules-v1" &&
    R.method === "simple-random-without-replacement" &&
    HEX32.test(R.populationRoot) &&
    Number.isInteger(R.populationCount) && R.populationCount >= 1 && R.populationCount <= 1_000_000 &&
    Number.isInteger(R.sampleSize) && R.sampleSize >= 1 && R.sampleSize <= Math.min(R.populationCount, 1000) &&
    R.randomness?.ledgerBeacon === true && R.randomness?.target === "bnb-block+100";
  if (!okRules) return [[false, "The rules in this receipt aren't valid FairSelect rules."]];
  const terms = { entriesCode: R.populationRoot, entryCount: R.populationCount, winnerCount: R.sampleSize, salt: selectionSalt(rulesHash(R), r.nonce) };
  const value = drawValueBeacon(terms);
  if (lc(value) !== lc(r.value)) return [[false, "The lock doesn't match the rules: they were changed after locking."]];
  out.push([true, `The rules (${R.populationCount} members, sample of ${R.sampleSize}) are the ones in the lock ${value}.`]);
  if (r.labels?.notes !== undefined) out.push(R.notesHash && lc(sha256(Buffer.from(r.labels.notes, "utf8"))) === lc(R.notesHash) ? [true, "The scope notes shared are the ones locked."] : [false, "The scope notes shared don't match the lock."]);
  if (r.labels?.memberField !== undefined) out.push(R.memberField && lc(sha256(Buffer.from(r.labels.memberField, "utf8"))) === lc(R.memberField) ? [true, `Members are identified by "${r.labels.memberField}", as locked.`] : [false, "The column name shared doesn't match the lock."]);

  out.push(...(await anchorLines(r.lockRecord, value, 7, rpcUrl, opts.submitter)));
  if (out.some(([ok]) => ok === false)) return out;

  const rnd = r.randomness;
  if (!rnd) return [...out, ["warn", "The receipt has no randomness yet: it was made before the result was final."]];
  if (rpcUrl && r.lockRecord) {
    const rec = await rpc(rpcUrl, "eth_getTransactionReceipt", [r.lockRecord.txHash]);
    const target = BigInt(rec.blockNumber) + 100n;
    if (BigInt(rnd.bnbBlock) !== target) return [...out, [false, `The random block should be #${target}, the lock's block + 100; the receipt names #${rnd.bnbBlock}.`]];
    const blk = await rpc(rpcUrl, "eth_getBlockByNumber", ["0x" + target.toString(16), false]);
    if (!blk || lc(blk.hash) !== lc(rnd.bnbBlockHash)) return [...out, [false, "The random block's hash on the chain doesn't match the receipt."]];
    out.push([true, `Random block #${target} read from the chain, made ${new Date(Number(blk.timestamp) * 1000).toISOString()}.`]);
  }
  const why = checkBeacon(rnd.beacon);
  if (why) return [...out, [false, `The Ledger random number doesn't check: ${why}`]];
  out.push(rnd.beacon.reveals.length ? [true, `The Ledger random number checks: ${rnd.beacon.reveals.length} witness(es) added randomness.`] : ["warn", "No witness added randomness: the Ledger part rests on VesTally alone (the BNB Chain block still applies)."]);
  if (rnd.beacon.secret === undefined) out.push(["warn", "This beacon predates the sealed sequencer secret (version 1)."]);
  out.push(["warn", "Not checked here: that the Ledger request came before the random block. The check page reads the Ledger for that."]);

  const sample = pickWinners(value, drawRandomness(rnd.bnbBlockHash, rnd.beacon.value), R.populationCount, R.sampleSize);
  if (r.selection) {
    const same = r.selection.length === sample.length && r.selection.every((s, i) => s.index === sample[i]);
    out.push(same ? [true, "The sample in the receipt is exactly the one the rules produce."] : [false, "The sample in the receipt is NOT the one the rules produce."]);
  } else out.push([true, `Sample (positions, 1-based): ${sample.map((i) => i + 1).join(", ")}.`]);

  const inSample = new Set(sample);
  for (const x of r.disclosures ?? []) {
    const ok = HEX32.test(x.salt) && Array.isArray(x.path) && walkPath(itemLeaf(DOMAINS.fairselect, x.index, x.salt, memberHash(x.member)), x.path) === lc(R.populationRoot);
    out.push(!ok ? [false, `Disclosed "${x.member}" is not at position ${x.index + 1} of the locked population.`] : inSample.has(x.index) ? [true, `"${x.member}" is at locked position ${x.index + 1} and in the sample.`] : ["warn", `"${x.member}" is in the population but wasn't selected.`]);
  }
  return out;
}

// ---------------------------------------------------------------- RecordProof

function listFiles(paths) {
  const out = [];
  const walk = (p, base) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e), base);
    else out.push({ name: relative(base, p).replace(/\\/g, "/") || p, sha256: sha256(readFileSync(p)) });
  };
  for (const p of paths) walk(p, statSync(p).isDirectory() ? p : join(p, ".."));
  return out;
}

export async function verifyRecordSet(r, given, rpcUrl, opts = {}) {
  const out = [];
  if (r.secret) {
    const root = merkleRoot(r.files.map((f) => itemLeaf(DOMAINS.recordproof, f.index, itemSalt(DOMAINS.recordproof, r.secret, f.index), f.sha256)));
    if (root !== lc(r.setCode) || r.files.length !== r.count || r.files.some((f, i) => f.index !== i)) return [[false, "The file list in this receipt doesn't make up its set code."]];
  } else {
    for (const x of r.disclosures ?? []) {
      const f = r.files.find((y) => y.index === x.index);
      if (!f || lc(f.sha256) !== lc(x.itemHash) || walkPath(itemLeaf(DOMAINS.recordproof, x.index, x.salt, x.itemHash), x.path) !== lc(r.setCode))
        return [[false, "A file in this receipt isn't part of its set code."]];
    }
  }
  out.push([true, `The receipt's ${r.files.length} file(s) are part of set code ${r.setCode} (${r.count} files in the set).`]);
  const bySha = new Map(r.files.map((f) => [lc(f.sha256), f]));
  const seen = new Set();
  for (const g of given) {
    const hit = bySha.get(lc(g.sha256));
    if (hit) {
      seen.add(hit.index);
      out.push([true, `${g.name}: identical to "${hit.name}".`]);
    } else {
      const named = r.files.find((f) => f.name === g.name || f.name.endsWith("/" + g.name));
      out.push(named ? [false, `${g.name}: CHANGED, not the file fingerprinted under that name.`] : ["warn", `${g.name}: not part of this set.`]);
      if (named) seen.add(named.index);
    }
  }
  if (given.length) for (const f of r.files) if (!seen.has(f.index)) out.push(["warn", `${f.name}: not provided for checking.`]);
  out.push(...(await anchorLines(r.record, r.setCode, 1, rpcUrl, opts.submitter)));
  return out;
}

// ---------------------------------------------------------------- command line

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const rpcUrl = take("--rpc") ?? process.env.RPC_URL;
  const submitter = take("--submitter");
  const [receiptPath, ...paths] = args;
  if (!receiptPath) {
    console.log("Usage: node verify-receipt.mjs <receipt.json> [files or folders…] --rpc <url>   (BNB Chain: https://bsc-rpc.publicnode.com)");
    process.exit(2);
  }
  const r = JSON.parse(readFileSync(receiptPath, "utf8"));
  const run =
    r.kind === "vestally-fairselect-receipt"
      ? verifySelection(r, rpcUrl, { submitter })
      : r.kind === "vestally-recordproof-receipt"
        ? verifyRecordSet(r, listFiles(paths), rpcUrl, { submitter })
        : Promise.resolve([[false, "Not a FairSelect or RecordProof receipt."]]);
  const lines = await run.catch((e) => [[false, e.message]]);
  for (const [ok, msg] of lines) console.log(`${ok === true ? "✓" : ok === "warn" ? "!" : "✗"} ${msg}`);
  const pass = lines.every(([ok]) => ok !== false);
  console.log(
    pass
      ? `\n${lines.some(([ok]) => ok === "warn") ? "VERIFIED, with warnings above." : "VERIFIED."} ${r.kind === "vestally-fairselect-receipt" ? "The selection followed the rules locked before the random number existed; the population is the organizer's own statement." : "The files are unchanged and existed by the recorded time; not who made them or that they're true."}`
      : "\nNOT VERIFIED.",
  );
  process.exit(pass ? 0 : 1);
}
