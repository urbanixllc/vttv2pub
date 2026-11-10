#!/usr/bin/env node
/**
 * VesTally independent proof verifier. One file, no dependencies, no VesTally servers.
 *
 *   node verify-proof.mjs <proof.json> [file-to-check] [--rpc <url>] [--submitter <address>]
 *
 * It checks a VesTally proof file (downloaded from a check page) against your copy of the file and
 * against the chain itself, through any public RPC you choose. Everything it does is written out
 * below and in the proof file's "rules", so it can be re-implemented in any language, years from now.
 *
 * Steps:
 *  1. If a file is given: SHA-256 of its bytes must equal the proof's code.
 *  2. leaf = keccak256(keccak256(abi.encode(uint8 leafKind, bytes32 code)))
 *  3. Walk the proof: h = keccak256(min(h, p) ‖ max(h, p)) for each p, comparing as hex. The result
 *     must equal the root.
 *  4. Over RPC: the chain ID matches; the transaction succeeded; it contains the event
 *     Anchored(address indexed submitter, bytes32 indexed root, uint256 count, bytes32 manifestDigest)
 *     from the proof's contract, with this root.
 *  5. The event's submitter is VesTally's relayer. RecordAnchor lets anyone publish a root, so a
 *     root someone anchored themselves must not pass as recorded by VesTally. On BNB Chain the
 *     relayer below is pinned; on other chains pass --submitter <address>.
 *  6. The recorded time is the timestamp of that transaction's block, read from the chain.
 *
 * What a pass means: this exact file (or code) was in a batch recorded on that chain by that block's
 * time. It does not show who made the file or that anything in it is true.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ---------- keccak-256 (the original Keccak padding used by Ethereum, not NIST SHA3) ----------
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[round];
  }
}

export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((s[i] >> BigInt(8 * k)) & 0xffn);
  return out;
}

// ---------- helpers ----------
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/i, ""), "hex"));
const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);

export function recordLeaf(kind, value) {
  const enc = new Uint8Array(64);
  enc[31] = kind;
  enc.set(bytes(value), 32);
  return hex(keccak256(keccak256(enc)));
}

export function walkProof(leaf, proof) {
  let h = leaf.toLowerCase();
  for (const p of proof) {
    const q = p.toLowerCase();
    const [a, b] = h < q ? [h, q] : [q, h];
    h = hex(keccak256(new Uint8Array([...bytes(a), ...bytes(b)])));
  }
  return h;
}

/** VesTally's published records on BNB Chain (chain 56): the RecordAnchor contract and the relayer that calls it. */
export const VESTALLY_ANCHORS = {
  56: { contract: "0x89d8eb0a3a5144e1dbe269cdee6dd3bbad8ef3c0", submitter: "0xcdd05bb4ec7dfe5f981a0a89a80ca505452c5408" },
};

const ANCHORED_TOPIC = hex(keccak256(new TextEncoder().encode("Anchored(address,bytes32,uint256,bytes32)")));

async function rpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Returns a list of [ok, message] lines. Exported for tests. */
export async function verify(proofFile, fileBytes, rpcUrl, opts = {}) {
  const p = proofFile;
  const out = [];
  const check = (ok, msg) => (out.push([ok, msg]), ok);
  if (p?.kind !== "vestally-proof") return [[false, "Not a VesTally proof file."]];
  const kind = p.leafKind ?? 1;
  const code = String(p.code ?? "").toLowerCase();
  if (!isHash(code) || !isHash(p.root) || !Array.isArray(p.proof) || !p.proof.every(isHash)) return [[false, "The proof file is malformed."]];

  if (fileBytes) {
    const sha = "0x" + createHash("sha256").update(fileBytes).digest("hex");
    if (!check(sha === code, sha === code ? "Same file: SHA-256 of the file equals the proof's code." : `Different file: its SHA-256 is ${sha}, the proof is for ${code}.`)) return out;
  } else check(true, "No file given: checking the code only.");

  const root = walkProof(recordLeaf(kind, code), p.proof);
  if (!check(root === p.root.toLowerCase(), root === p.root.toLowerCase() ? "The Merkle path leads from the code to the batch root." : "The Merkle path does not lead to the root.")) return out;

  if (!rpcUrl) {
    check(false, "No RPC given (--rpc <url>), so the chain wasn't checked. Not verified.");
    return out;
  }
  const chainId = Number(await rpc(rpcUrl, "eth_chainId", []));
  if (!check(chainId === p.chainId, chainId === p.chainId ? `Connected to chain ${chainId}.` : `The RPC is chain ${chainId}, the proof is for chain ${p.chainId}.`)) return out;
  const receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [p.txHash]);
  if (!check(Boolean(receipt), receipt ? "Found the recording transaction." : "The recording transaction isn't on this chain.")) return out;
  if (!check(receipt.status === "0x1", receipt.status === "0x1" ? "The transaction succeeded." : "The transaction failed.")) return out;
  const log = receipt.logs.find((l) => l.address.toLowerCase() === String(p.contract).toLowerCase() && l.topics[0]?.toLowerCase() === ANCHORED_TOPIC && l.topics[2]?.toLowerCase() === p.root.toLowerCase());
  if (!check(Boolean(log), log ? `The transaction published this root from contract ${p.contract}.` : "The transaction doesn't publish this root from the proof's contract.")) return out;
  const submitter = ("0x" + log.topics[1].slice(26)).toLowerCase();
  const expected = (opts.submitter ?? VESTALLY_ANCHORS[chainId]?.submitter ?? "").toLowerCase();
  if (!expected) {
    check(false, `Published by ${submitter}, but no VesTally relayer is known for chain ${chainId}. Pass --submitter <address> to confirm who recorded it.`);
    return out;
  }
  const pinned = VESTALLY_ANCHORS[chainId];
  if (pinned && !opts.submitter && String(p.contract).toLowerCase() !== pinned.contract) {
    check(false, `The proof names contract ${p.contract}, not VesTally's RecordAnchor (${pinned.contract}).`);
    return out;
  }
  if (!check(submitter === expected, submitter === expected ? `Published by VesTally's relayer (${submitter}).` : `Published by ${submitter}, not VesTally's relayer (${expected}). Anyone can publish a root to this contract, so this is not a VesTally record.`)) return out;
  const block = await rpc(rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  const at = new Date(Number(block.timestamp) * 1000);
  check(true, `Recorded in block ${Number(receipt.blockNumber)} at ${at.toISOString()} (the chain's own time).`);
  return out;
}

// ---------- command line ----------
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--rpc");
  const rpcUrl = i >= 0 ? args.splice(i, 2)[1] : process.env.RPC_URL;
  const j = args.indexOf("--submitter");
  const submitter = j >= 0 ? args.splice(j, 2)[1] : undefined;
  const [proofPath, filePath] = args;
  if (!proofPath) {
    console.log("Usage: node verify-proof.mjs <proof.json> [file] --rpc <url>   (BSC: https://bsc-rpc.publicnode.com)");
    process.exit(2);
  }
  const lines = await verify(JSON.parse(readFileSync(proofPath, "utf8")), filePath ? readFileSync(filePath) : null, rpcUrl, { submitter }).catch((e) => [[false, e.message]]);
  for (const [ok, msg] of lines) console.log(`${ok ? "✓" : "✗"} ${msg}`);
  const pass = lines.every(([ok]) => ok);
  console.log(pass ? "\nVERIFIED. This shows the file is unchanged and existed by that time, not who made it or that it's true." : "\nNOT VERIFIED.");
  process.exit(pass ? 0 : 1);
}
