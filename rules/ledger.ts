import { concat, encodeAbiParameters, keccak256, recoverMessageAddress, stringToBytes, type Address, type Hex } from "viem";
import { buildSealTree, recordLeaf, verifyRecordProof, type LeafKind } from "./seal";

/**
 * VesTally Blockchain Ledger: instant records in hash-linked blocks, co-signed by community witnesses, with each
 * day's state anchored on BNB Chain. See docs/vtt-ledger-design.md.
 *
 * - A record is the same (leaf kind, 32-byte value) pair that goes into the daily anchor.
 * - A block holds the records received in the last few seconds. Its hash commits to its height,
 *   the previous block's hash, its time and the Merkle root of its records, so changing any old
 *   record breaks every later block.
 * - The sequencer signs each block hash. Witnesses keep their own full copy, check each block only
 *   extends the last one, then co-sign it. Co-signatures use a different digest, so a sequencer
 *   signature can never pass as a witness's.
 * - The daily anchor includes a kind-11 checkpoint leaf: the latest block hash, which commits to
 *   the whole ledger history up to then.
 */

export const LEDGER_GENESIS_PREV = `0x${"00".repeat(32)}` as Hex;
export const EMPTY_ROOT = `0x${"00".repeat(32)}` as Hex;
const BLOCK_DOMAIN = keccak256(stringToBytes("VesTally Blockchain Ledger block v1"));
const COSIGN_DOMAIN = stringToBytes("VesTally Blockchain Ledger cosign v1");

export interface LedgerRecord {
  kind: LeafKind;
  value: Hex;
}

export interface LedgerBlockHeader {
  height: number;
  prevHash: Hex;
  /** Unix milliseconds, from the sequencer's clock. A statement, not proof: the BNB Chain anchor is. */
  time: number;
  recordsRoot: Hex;
}

export interface LedgerBlock extends LedgerBlockHeader {
  records: LedgerRecord[];
  hash: Hex;
  sequencerSig: Hex;
}

export interface Cosignature {
  witness: Address;
  signature: Hex;
}

/** What a user gets for one record: enough to check it was in a signed, co-signed block. */
export interface LedgerReceipt {
  record: LedgerRecord;
  height: number;
  time: number;
  prevHash: Hex;
  recordsRoot: Hex;
  blockHash: Hex;
  /** Merkle path from recordLeaf(kind, value) to recordsRoot (same tree rules as the daily anchor). */
  proof: Hex[];
  sequencerSig: Hex;
  cosigs: Cosignature[];
}

const leafOf = (r: LedgerRecord) => recordLeaf(r.kind, r.value.toLowerCase() as Hex);

export function recordsRoot(records: readonly LedgerRecord[]): Hex {
  return records.length ? buildSealTree(records.map(leafOf)).root : EMPTY_ROOT;
}

export function blockHash(h: LedgerBlockHeader): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }],
      [BLOCK_DOMAIN, BigInt(h.height), h.prevHash, BigInt(h.time), h.recordsRoot],
    ),
  );
}

/** What a witness signs (EIP-191 over these raw bytes). */
export function cosignDigest(hash: Hex): Hex {
  return keccak256(concat([COSIGN_DOMAIN, hash]));
}

/** The Merkle path for one record in a block, or null if it isn't there. */
export function recordProof(block: Pick<LedgerBlock, "records">, record: LedgerRecord): Hex[] | null {
  if (!block.records.length) return null;
  const tree = buildSealTree(block.records.map(leafOf));
  return tree.proofs.get(leafOf(record).toLowerCase() as Hex) ?? null;
}

/**
 * Checks a block on its own and against the block before it. Returns a reason, or null if it's fine.
 * `prev` is null only for height 0.
 */
export async function checkBlock(b: LedgerBlock, prev: Pick<LedgerBlock, "height" | "hash" | "time"> | null, sequencer: Address): Promise<string | null> {
  if (prev === null) {
    if (b.height !== 0 || b.prevHash !== LEDGER_GENESIS_PREV) return "The first block must be height 0 with an empty previous hash.";
  } else {
    if (b.height !== prev.height + 1) return `Expected height ${prev.height + 1}, got ${b.height}.`;
    if (b.prevHash.toLowerCase() !== prev.hash.toLowerCase()) return `Block ${b.height} doesn't link to block ${prev.height}.`;
    if (b.time < prev.time) return `Block ${b.height} goes back in time.`;
  }
  if (recordsRoot(b.records).toLowerCase() !== b.recordsRoot.toLowerCase()) return `Block ${b.height}'s records don't match its root.`;
  if (blockHash(b).toLowerCase() !== b.hash.toLowerCase()) return `Block ${b.height}'s hash is wrong.`;
  try {
    const who = await recoverMessageAddress({ message: { raw: b.hash }, signature: b.sequencerSig });
    if (who.toLowerCase() !== sequencer.toLowerCase()) return `Block ${b.height} isn't signed by the sequencer.`;
  } catch {
    return `Block ${b.height} has an unreadable sequencer signature.`;
  }
  return null;
}

export async function cosigner(hash: Hex, signature: Hex): Promise<Address | null> {
  try {
    return await recoverMessageAddress({ message: { raw: cosignDigest(hash) }, signature });
  } catch {
    return null;
  }
}

/** One witness in the published witness set. Co-signatures count for blocks in [fromHeight, untilHeight). */
export interface WitnessEntry {
  witness: Address;
  label: string;
  fromHeight: number;
  untilHeight: number | null;
  latestCosigned?: number;
}

/** The value logged (leaf kind 12) when the witness set changes, so every change is on the record. */
export function witnessChangeValue(action: "add" | "remove", witness: Address, height: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "uint64" }], [action, witness, BigInt(height)]));
}

/** Which witnesses' co-signatures count for a block at this height. */
export function witnessesAt(set: readonly WitnessEntry[], height: number): Address[] {
  return set.filter((w) => w.untilHeight === null || height < w.untilHeight).map((w) => w.witness);
}

export type ReceiptCheck =
  | { ok: true; cosignedBy: Address[]; time: Date; height: number }
  | { ok: false; reason: string };

/**
 * Checks a receipt with nothing but the receipt and the published keys: the record is in the block,
 * the block hash is right, the sequencer signed it, and which of the known witnesses co-signed it.
 */
export async function checkReceipt(r: LedgerReceipt, expected: LedgerRecord, sequencer: Address, witnesses: readonly Address[]): Promise<ReceiptCheck> {
  if (r.record.kind !== expected.kind || r.record.value.toLowerCase() !== expected.value.toLowerCase())
    return { ok: false, reason: "The receipt is for a different record." };
  if (!verifyRecordProof(expected.kind, expected.value.toLowerCase() as Hex, r.proof, r.recordsRoot))
    return { ok: false, reason: "The record isn't in the block the receipt names." };
  const hash = blockHash(r);
  if (hash.toLowerCase() !== r.blockHash.toLowerCase()) return { ok: false, reason: "The block hash in the receipt is wrong." };
  try {
    const who = await recoverMessageAddress({ message: { raw: hash }, signature: r.sequencerSig });
    if (who.toLowerCase() !== sequencer.toLowerCase()) return { ok: false, reason: "The block isn't signed by the VesTally Blockchain Ledger sequencer." };
  } catch {
    return { ok: false, reason: "The block's signature can't be read." };
  }
  const known = new Set(witnesses.map((w) => w.toLowerCase()));
  const cosignedBy: Address[] = [];
  for (const c of r.cosigs) {
    const who = await cosigner(hash, c.signature);
    if (who && known.has(who.toLowerCase()) && who.toLowerCase() === c.witness.toLowerCase() && !cosignedBy.some((w) => w.toLowerCase() === who.toLowerCase()))
      cosignedBy.push(who);
  }
  return { ok: true, cosignedBy, time: new Date(r.time), height: r.height };
}
