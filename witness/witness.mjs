#!/usr/bin/env node
/**
 * VesTally Blockchain Ledger: community witness. Runs on your own computer.
 *
 * A witness keeps its own full copy of the Ledger, checks that every new block only adds to the last
 * one (right height, linked to the previous block, records matching the root, signed by VesTally's
 * sequencer), and co-signs it. If VesTally ever served a rewritten history, this witness refuses to
 * sign and stops with an alert. That's the point of having witnesses outside VesTally.
 *
 *   npm install                      (once: installs viem, the only dependency)
 *   node witness.mjs init            makes your witness key on this computer and prints its address
 *   node witness.mjs run --site https://vestallytoken.io --sequencer 0x... --label "Your name"
 *
 * The first run asks to join: it sends the site a request signed with your witness key (address and
 * label only). An admin approves it in the admin panel; until then the program keeps its copy up to
 * date, and once approved it co-signs everything it holds. Your key never leaves this computer.
 * This is an independent implementation of the block rules (it doesn't use VesTally's own code),
 * which is a check in itself.
 *
 * Randomness: when a block asks for a random number (a bingo ball, say), this witness adds the next
 * value from its own hash chain (witness-data/beacon.json, made automatically). Nobody else knows
 * that value in advance, so nobody, VesTally included, can see the number coming. It costs a few
 * bytes per request and a fraction of a second once at startup. Every contribution VesTally accepts
 * comes with a signed receipt (kept in witness-data/receipts.jsonl): if it were ever left out, the
 * receipt proves it to anyone.
 *
 * The daily anchor: about every ten minutes this witness reads VesTally's latest anchor transactions
 * straight from BNB Chain (through a public node, not through VesTally) and checks that the anchored
 * checkpoint is a block in its own copy. If VesTally ever showed this witness one history and
 * anchored another, this is where it shows. Options: --bnb-rpc <url>, --anchor-contract <0x...>,
 * --anchor-check off.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, concat, encodeAbiParameters, getAddress, keccak256, recoverMessageAddress, stringToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** Shown at startup; README and the Ledger page say which is current. */
export const VERSION = "2026.11.11";
const KEY_FILE = "witness-key.json";
const DATA = "witness-data";
const GENESIS_PREV = `0x${"00".repeat(32)}`;
const EMPTY_ROOT = `0x${"00".repeat(32)}`;

// ---------- the block rules (docs/vtt-ledger-design.md) ----------
const BLOCK_DOMAIN = keccak256(stringToBytes("VesTally Blockchain Ledger block v1"));
const COSIGN_DOMAIN = stringToBytes("VesTally Blockchain Ledger cosign v1");

/** leaf = keccak256(keccak256(abi.encode(uint8 kind, bytes32 value))) */
export const leafOf = (r) => keccak256(keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [r.kind, r.value.toLowerCase()])));
const pair = (a, b) => (a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/** Merkle root: leaves sorted and de-duplicated; pairs hashed in sorted order; an odd node moves up unchanged. */
export function recordsRoot(records) {
  if (!records.length) return EMPTY_ROOT;
  return merkleRoot(records.map((r) => leafOf(r)));
}

/** The same tree over leaves already made (the daily anchor's manifest is a list of leaves). */
export function merkleRoot(leaves) {
  let level = [...new Set(leaves.map((l) => l.toLowerCase()))].sort();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(level[i + 1] ? pair(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

export const blockHash = (b) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }],
      [BLOCK_DOMAIN, BigInt(b.height), b.prevHash, BigInt(b.time), b.recordsRoot],
    ),
  );
export const cosignDigest = (hash) => keccak256(concat([COSIGN_DOMAIN, hash]));

export async function checkBlock(b, prev, sequencer) {
  if (!prev) {
    if (b.height !== 0 || b.prevHash !== GENESIS_PREV) return "the first block must be height 0";
  } else {
    if (b.height !== prev.height + 1) return `expected height ${prev.height + 1}, got ${b.height}`;
    if (b.prevHash.toLowerCase() !== prev.hash.toLowerCase()) return `block ${b.height} doesn't link to block ${prev.height}`;
    if (b.time < prev.time) return `block ${b.height} goes back in time`;
  }
  if (recordsRoot(b.records).toLowerCase() !== b.recordsRoot.toLowerCase()) return `block ${b.height}'s records don't match its root`;
  if (blockHash(b).toLowerCase() !== b.hash.toLowerCase()) return `block ${b.height}'s hash is wrong`;
  const who = await recoverMessageAddress({ message: { raw: b.hash }, signature: b.sequencerSig }).catch(() => null);
  if (!who || who.toLowerCase() !== sequencer.toLowerCase()) return `block ${b.height} isn't signed by the sequencer`;
  return null;
}

// ---------- randomness: a hash chain (docs/vtt-ledger-design.md, "Randomness beacon") ----------
const RANDOM_REQUEST = 16;
const BEACON_SECRET = 18;
const LEDGER_CHECKPOINT = 11;
const BEACON_V1 = keccak256(stringToBytes("VesTally Blockchain Ledger beacon v1"));
const BEACON_V2 = keccak256(stringToBytes("VesTally Blockchain Ledger beacon v2"));
const SECRET_DOMAIN = keccak256(stringToBytes("VesTally Blockchain Ledger beacon secret v1"));
/** Must match the site's beaconReceiptMessage exactly. */
export const receiptMessage = (height, address, index, value) =>
  `VesTally beacon reveal accepted\nBlock: ${height}\nWitness: ${getAddress(address)}\nIndex: ${index}\nValue: ${value.toLowerCase()}`;

/** A closed beacon's value from its inputs: the request block's hash, the sealed secret (v2) and the reveals, sorted by witness. */
export function beaconValue(b) {
  const r = [...b.reveals].sort((x, y) => (x.witness.toLowerCase() < y.witness.toLowerCase() ? -1 : 1));
  const list = [r.map((x) => getAddress(x.witness)), r.map((x) => BigInt(x.index)), r.map((x) => x.value)];
  if (b.secret === undefined)
    return keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "address[]" }, { type: "uint64[]" }, { type: "bytes32[]" }],
        [BEACON_V1, BigInt(b.height), b.blockHash, ...list],
      ),
    );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address[]" }, { type: "uint64[]" }, { type: "bytes32[]" }],
      [BEACON_V2, BigInt(b.height), b.blockHash, b.secret, ...list],
    ),
  );
}
export const secretCommit = (secret) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [SECRET_DOMAIN, secret]));

/** Checks a closed beacon against the request block this witness holds. Returns a problem, or null. */
export function checkClosedBeacon(b, block) {
  if (beaconValue(b).toLowerCase() !== b.value.toLowerCase()) return "its value doesn't follow from its inputs";
  if (!block) return null;
  if (block.hash.toLowerCase() !== b.blockHash.toLowerCase()) return "it names a different request block";
  const commits = block.records.filter((r) => r.kind === BEACON_SECRET);
  if (b.secret === undefined) return commits.length ? "it leaves out the secret sealed in its request block" : null;
  if (commits.length !== 1 || commits[0].value.toLowerCase() !== secretCommit(b.secret).toLowerCase()) return "its secret isn't the one sealed in its request block";
  return null;
}

// ---------- the daily anchor on BNB Chain ----------
const ANCHORED_TOPIC = keccak256(stringToBytes("Anchored(address,bytes32,uint256,bytes32)"));
export const DEFAULT_ANCHOR_CONTRACT = "0x89D8EB0A3A5144E1dbE269CDee6dD3BBad8EF3C0";
export const DEFAULT_BNB_RPC = "https://bsc-dataseed.bnbchain.org";

/** A transaction receipt, read from a BNB Chain node of your choosing (never through VesTally). */
export async function rpcReceipt(rpc, txHash) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`BNB Chain node: HTTP ${res.status}`);
  return (await res.json()).result ?? null;
}

/**
 * One anchored batch against this witness's copy: the manifest rebuilds the root, the root is in an
 * Anchored event of the pinned contract in that transaction on BNB Chain, and the batch's Ledger
 * checkpoint (a kind-11 leaf of a block hash) is a block this witness holds.
 * Returns { status: "ok", height } | { status: "later", why } | { status: "alert", why }.
 */
export function checkAnchor({ manifest, receipt, contract, blocks, recordedAt }) {
  const leaves = [...new Set((manifest.leaves ?? []).map((l) => l.toLowerCase()))].sort();
  if (!leaves.length || merkleRoot(leaves).toLowerCase() !== manifest.root.toLowerCase()) return { status: "alert", why: `anchor batch ${manifest.id}'s leaves don't rebuild its root` };
  if (keccak256(concat(leaves)).toLowerCase() !== manifest.manifestDigest.toLowerCase()) return { status: "alert", why: `anchor batch ${manifest.id}'s leaves don't match its digest` };
  if (!receipt) return { status: "later", why: `transaction ${manifest.txHash} isn't visible on this BNB Chain node yet` };
  const onChain =
    receipt.status === "0x1" &&
    (receipt.logs ?? []).some(
      (l) =>
        l.address.toLowerCase() === contract.toLowerCase() &&
        (l.topics[0] ?? "").toLowerCase() === ANCHORED_TOPIC.toLowerCase() &&
        (l.topics[2] ?? "").toLowerCase() === manifest.root.toLowerCase(),
    );
  if (!onChain) return { status: "alert", why: `anchor batch ${manifest.id}'s root isn't in an Anchored event of ${contract} in transaction ${manifest.txHash}` };
  const set = new Set(leaves);
  const cutoff = recordedAt - 3 * 86_400_000;
  for (let i = blocks.length - 1; i >= 0 && blocks[i].time >= cutoff; i--) {
    const b = blocks[i];
    if (b.time > recordedAt) continue;
    if (set.has(leafOf({ kind: LEDGER_CHECKPOINT, value: b.hash }).toLowerCase())) return { status: "ok", height: b.height };
  }
  if (!blocks.length || blocks.at(-1).time < recordedAt) return { status: "later", why: "this copy hasn't reached the anchor's time yet" };
  return {
    status: "alert",
    why: `the BNB Chain anchor in ${manifest.txHash} holds no checkpoint of any block in your copy. Either that anchor skipped its checkpoint, or VesTally anchored a different history from the one it showed you`,
  };
}
const CHAIN_LENGTH = 100_000;
/** Must match the site's beaconCommitMessage exactly. */
const commitMessage = (address, top, length, time) => `VesTally beacon commitment\nWitness: ${getAddress(address)}\nTop: ${top.toLowerCase()}\nLength: ${length}\nTime: ${time}`;

/**
 * s0 = secret, s(k+1) = keccak(s(k)); the top s(N) is published. Reveal i is s(N - i), so each reveal
 * hashes to the previous one. Checkpoints every 1,000 steps keep each reveal quick.
 */
export function makeChain(secret, length) {
  const checkpoints = [];
  let v = secret;
  for (let k = 0; k < length; k++) {
    if (k % 1000 === 0) checkpoints.push(v);
    v = keccak256(v);
  }
  return {
    top: v,
    reveal(i) {
      const k = length - i;
      let x = checkpoints[Math.floor(k / 1000)];
      for (let j = 0; j < k % 1000; j++) x = keccak256(x);
      return x;
    },
  };
}

function saveJson(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

// ---------- running ----------
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function api(site, path, init) {
  const res = await fetch(`${site.replace(/\/$/, "")}/api/ledger/${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

// ---------- joining: a request signed with the witness key ----------
/** Must match the site's requestMessage exactly. */
const requestMessage = (address, label, time) => `VesTally witness request\nAddress: ${getAddress(address)}\nLabel: ${label}\nTime: ${time}`;

async function requestStatus(site, address) {
  const res = await fetch(`${site.replace(/\/$/, "")}/api/witness-requests/${address}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`status: HTTP ${res.status}`);
  return (await res.json()).status;
}

async function sendRequest(site, account, label) {
  const time = Date.now();
  const signature = await account.signMessage({ message: requestMessage(account.address, label, time) });
  const res = await fetch(`${site.replace(/\/$/, "")}/api/witness-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address, label, time, signature }),
    signal: AbortSignal.timeout(15_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out.status;
}

async function run() {
  // Settings come from the command line, or from WITNESS_* environment variables (handy for Docker).
  const site = arg("site") ?? process.env.WITNESS_SITE ?? "https://vestallytoken.io";
  const sequencer = arg("sequencer") ?? process.env.WITNESS_SEQUENCER;
  const label = arg("label") ?? process.env.WITNESS_LABEL;
  if (!/^0x[0-9a-fA-F]{40}$/.test(sequencer ?? "")) {
    console.log('Usage: node witness.mjs run --sequencer <0x… address shown on the Ledger page> --label "Your name" [--site https://vestallytoken.io]');
    process.exit(2);
  }
  console.log(`VesTally witness ${VERSION}`);
  if (!existsSync(KEY_FILE)) {
    console.log("No witness key yet, so making one now.");
    init();
  }
  const account = privateKeyToAccount(JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey);
  mkdirSync(DATA, { recursive: true });
  const file = join(DATA, "blocks.jsonl");
  const blocks = [];
  if (existsSync(file)) {
    // A crash or full disk can leave the last line half written: drop just that line and carry on.
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n");
    let good = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) { good += lines[i].length + 1; continue; }
      try {
        blocks.push(JSON.parse(lines[i]));
        good += lines[i].length + 1;
      } catch {
        if (lines.slice(i + 1).some((l) => l.trim())) throw new Error(`${file}: line ${i + 1} is damaged. Delete the file to download a fresh copy.`);
        console.warn("Dropped an unfinished last line in blocks.jsonl (left by a crash or full disk).");
        writeFileSync(file, raw.slice(0, Math.min(good, raw.length)));
        break;
      }
    }
  }
  console.log(`Witness ${account.address}. Holding ${blocks.length} block(s). Watching ${site}.`);

  // The randomness chain: made once, replaced by itself when nearly used up or if the file is lost.
  const chainFile = join(DATA, "beacon.json");
  let chainState = null;
  let chain = null;
  const loadChain = () => {
    if (!chainState && existsSync(chainFile)) {
      try { chainState = JSON.parse(readFileSync(chainFile, "utf8")); } catch { chainState = null; }
    }
    if (!chainState || chainState.next > chainState.length - 10) {
      chainState = { secret: bytesToHex(randomBytes(32)), length: CHAIN_LENGTH, time: Date.now(), next: 1 };
      saveJson(chainFile, chainState);
      chain = null;
      committed = false;
    }
    chain ??= makeChain(chainState.secret, chainState.length);
  };
  let committed = false;
  let lastCommitTry = 0;
  let lastRequest = 0;
  const sentReveals = [];
  const ensureCommit = async () => {
    loadChain();
    if (committed || Date.now() - lastCommitTry < 60_000) return;
    lastCommitTry = Date.now();
    try {
      const status = await api(site, "beacon");
      const mine = status.witnesses?.find((w) => w.witness.toLowerCase() === account.address.toLowerCase());
      if (mine && mine.top.toLowerCase() === chain.top.toLowerCase()) { committed = true; return; }
      const signature = await account.signMessage({ message: commitMessage(account.address, chain.top, chainState.length, chainState.time) });
      await api(site, "beacon/commits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ witness: account.address, top: chain.top, length: chainState.length, time: chainState.time, signature }) });
      committed = true;
      console.log("Randomness: your chain is published. You'll add to random numbers when the site asks for them.");
    } catch (e) {
      console.warn(`  randomness chain not published yet (${e.message}); will retry.`);
    }
  };
  const reveal = async (height) => {
    if (!committed) return;
    loadChain();
    const index = chainState.next;
    chainState = { ...chainState, next: index + 1 };
    saveJson(chainFile, chainState); // used before it's sent, so a value is never sent twice
    const value = chain.reveal(index);
    try {
      const out = await api(site, "beacon/reveals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ height, witness: account.address, index, value }) });
      // VesTally's signed receipt for exactly this contribution: kept on disk as proof.
      const who = out?.receipt ? await recoverMessageAddress({ message: receiptMessage(height, account.address, index, value), signature: out.receipt }).catch(() => null) : null;
      const receipt = who && who.toLowerCase() === sequencer.toLowerCase() ? out.receipt : null;
      if (receipt) appendFileSync(join(DATA, "receipts.jsonl"), JSON.stringify({ height, witness: account.address, index, value, receipt }) + "\n");
      else console.error(`ALERT: VesTally took your random contribution for block ${height} without a valid signed receipt.`);
      sentReveals.push({ height, index, value, receipt, at: Date.now() });
    } catch (e) {
      if (/no-commitment|bad-reveal/.test(e.message)) { committed = false; lastCommitTry = 0; }
      const block = blocks.find((b) => b.height === height);
      // Turned away as "closed" well inside the 6-second window: an on-time contribution was refused.
      if (/"closed"/.test(e.message) && block && Date.now() - block.time < 4_000)
        console.error(`ALERT: VesTally turned away your on-time random contribution for block ${height} (a VesTally restart can also do this). Keep this log.`);
      else if (!/409/.test(e.message)) console.warn(`  random contribution for block ${height} not accepted (${e.message}).`);
    }
  };
  // A contribution the site accepted must show up in that block's random number.
  const checkReveals = async () => {
    for (const x of sentReveals.filter((r) => Date.now() - r.at > 10_000)) {
      const b = await api(site, `beacon/${x.height}`).catch((e) => (/404/.test(e.message) ? null : undefined));
      if (b === undefined || (b && !b.final)) continue;
      sentReveals.splice(sentReveals.indexOf(x), 1);
      if (!b?.reveals?.some((r) => r.witness.toLowerCase() === account.address.toLowerCase() && r.index === x.index)) {
        const proof = x.receipt ? ` VesTally's signed receipt proves it: ${JSON.stringify({ height: x.height, witness: account.address, index: x.index, value: x.value, receipt: x.receipt })}` : "";
        console.error(`ALERT: VesTally accepted your random contribution for block ${x.height} but left it out. Keep this log and tell the community.${proof}`);
        continue;
      }
      const why = checkClosedBeacon(b, blocks.find((y) => y.height === x.height));
      if (why) console.error(`ALERT: the random number for block ${x.height} doesn't check out: ${why}. Keep this log and tell the community.`);
    }
  };

  // The daily anchor, read from BNB Chain directly: is its checkpoint a block in this copy?
  const anchorCheck = (arg("anchor-check") ?? process.env.WITNESS_ANCHOR_CHECK ?? "on") !== "off";
  const bnbRpc = arg("bnb-rpc") ?? process.env.WITNESS_BNB_RPC ?? DEFAULT_BNB_RPC;
  const anchorContract = arg("anchor-contract") ?? process.env.WITNESS_ANCHOR_CONTRACT ?? DEFAULT_ANCHOR_CONTRACT;
  const anchorsFile = join(DATA, "anchors.json");
  const anchorsDone = new Set(existsSync(anchorsFile) ? JSON.parse(readFileSync(anchorsFile, "utf8")) : []);
  let lastAnchorCheck = 0;
  const siteBase = site.replace(/\/$/, "");
  const checkAnchors = async () => {
    if (!anchorCheck || Date.now() - lastAnchorCheck < 600_000) return;
    lastAnchorCheck = Date.now();
    try {
      const res = await fetch(`${siteBase}/api/anchors`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      const { batches = [] } = await res.json();
      for (const batch of batches.slice(0, 5).reverse()) {
        if (anchorsDone.has(batch.id) || !batch.txHash || !batch.recordedAt) continue;
        const m = await fetch(`${siteBase}/api/anchors/${batch.id}/manifest`, { signal: AbortSignal.timeout(15_000) });
        if (!m.ok) continue;
        const manifest = await m.json();
        const receipt = await rpcReceipt(bnbRpc, manifest.txHash);
        const result = checkAnchor({ manifest, receipt, contract: anchorContract, blocks, recordedAt: Date.parse(batch.recordedAt) });
        if (result.status === "later") continue;
        anchorsDone.add(batch.id);
        saveJson(anchorsFile, [...anchorsDone]);
        if (result.status === "ok") console.log(`BNB Chain anchor ${manifest.txHash.slice(0, 12)}... confirms your copy up to block #${result.height}.`);
        else console.error(`ALERT: ${result.why}. Keep ${file} as evidence and tell the community.`);
      }
    } catch (e) {
      console.warn(`  couldn't check the daily anchor (${e.message}); will retry.`);
    }
  };

  // Are we on the witness list? If not, ask to join (once), then keep checking.
  let approved = false;
  let lastCheck = 0;
  const checkApproval = async () => {
    lastCheck = Date.now();
    const status = await requestStatus(site, account.address);
    if (status === "approved") {
      if (!approved) console.log("You're on the witness list. Co-signing.");
      approved = true;
      return;
    }
    approved = false;
    if (status === "pending") return;
    if (!label || label.trim().length < 2) {
      console.log('Not a witness yet. Add --label "Your name" (2 to 60 characters, shown publicly) to ask to join.');
      return;
    }
    const s = await sendRequest(site, account, label.trim());
    console.log(s === "approved" ? "You're on the witness list. Co-signing." : "Asked to join the witness list. Waiting for approval; your copy keeps up meanwhile.");
    approved = s === "approved";
  };
  await checkApproval().catch((e) => console.warn(`Couldn't check the witness list (${e.message}); will retry.`));
  // How far our copy is co-signed. When approval comes, everything already checked gets co-signed.
  let backlog = approved ? blocks.length : 0;

  for (;;) {
    try {
      const head = await api(site, "head");
      const mine = blocks.at(-1);
      if (mine) {
        const [theirs] = await api(site, `blocks?from=${mine.height}&limit=1`);
        if (!theirs || theirs.hash.toLowerCase() !== mine.hash.toLowerCase()) {
          console.error(`ALERT: the site's block ${mine.height} differs from the copy you co-signed. History was rewritten. Stopping; keep ${file} as evidence.`);
          process.exit(1);
        }
      }
      if (!approved && Date.now() - lastCheck > 60_000) await checkApproval();
      if (approved) {
        await ensureCommit();
        await checkReveals();
      }
      await checkAnchors();
      // Just approved: vouch for the copy we already checked.
      if (approved && backlog < blocks.length) {
        const n = blocks.length - backlog;
        for (; backlog < blocks.length; backlog++) {
          const b = blocks[backlog];
          const signature = await account.signMessage({ message: { raw: cosignDigest(b.hash) } });
          await api(site, "cosigs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ height: b.height, witness: account.address, signature }) }).catch(() => {});
        }
        console.log(`Co-signed the ${n} block(s) already in your copy.`);
      }
      let next = mine ? mine.height + 1 : 0;
      let signed = 0;
      let checked = 0;
      while (head && next <= head.height) {
        const batch = await api(site, `blocks?from=${next}&limit=200`);
        if (!batch.length) break;
        for (const b of batch) {
          const problem = await checkBlock(b, blocks.at(-1), sequencer);
          if (problem) {
            console.error(`ALERT: refused ${problem}. Stopping.`);
            process.exit(1);
          }
          appendFileSync(file, JSON.stringify(b) + "\n");
          blocks.push(b);
          checked++;
          if (approved) {
            const signature = await account.signMessage({ message: { raw: cosignDigest(b.hash) } });
            await api(site, "cosigs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ height: b.height, witness: account.address, signature }) }).catch((e) => {
              console.warn(`  co-signature for block ${b.height} not accepted (${e.message}).`);
              if (/403/.test(e.message)) lastCheck = 0; // maybe removed from the list: check again
            });
            signed++;
            backlog = blocks.length;
            // A live request for a random number: add ours. Old ones (when catching up) are skipped.
            if (b.records.some((r) => r.kind === RANDOM_REQUEST) && b.time > Date.now() - 60_000) {
              lastRequest = Date.now();
              await reveal(b.height);
            }
          }
          next = b.height + 1;
        }
      }
      if (signed) console.log(`${new Date().toISOString()}  checked and co-signed ${signed} block(s); now at #${blocks.at(-1).height}`);
      else if (checked) console.log(`${new Date().toISOString()}  checked ${checked} block(s); now at #${blocks.at(-1).height} (waiting for approval to co-sign)`);
    } catch (e) {
      console.warn(`${new Date().toISOString()}  ${e.message}; retrying`);
    }
    // Every 3 seconds; every second for two minutes after a random-number request (a game is on).
    await new Promise((r) => setTimeout(r, Date.now() - lastRequest < 120_000 ? 1_000 : 3_000));
  }
}

function init() {
  if (existsSync(KEY_FILE)) {
    const a = privateKeyToAccount(JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey);
    console.log(`You already have a witness key. Address: ${a.address}`);
    return;
  }
  const privateKey = generatePrivateKey();
  writeFileSync(KEY_FILE, JSON.stringify({ privateKey, note: "VesTally witness key. Keep it on this computer. Never send it to anyone." }, null, 2), { mode: 0o600 });
  console.log(`Witness key created in ${KEY_FILE} (keep it private and backed up).`);
  console.log(`Your witness address: ${privateKeyToAccount(privateKey).address}`);
  if (process.argv[2] === "init") console.log('Next: node witness.mjs run --sequencer <address> --label "Your name". It asks to join for you.');
}

const cmd = process.argv[2];
if (process.argv[1]?.replace(/\\/g, "/").endsWith("witness.mjs")) {
  // Stop cleanly when asked (Docker, systemd, Task Scheduler). Every write is complete or atomic.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  if (cmd === "init") init();
  else if (cmd === "run") await run();
  else if (cmd === "version") console.log(VERSION);
  else console.log('Commands: init | run --sequencer <address> --label "Your name" [--site <url>] | version');
}
