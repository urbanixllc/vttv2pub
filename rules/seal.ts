import { concat, encodeAbiParameters, keccak256, type Hex } from "viem";

/**
 * Seal proofs. A seal code is the SHA-256 of a file, worked out on the person's device. Each day's
 * codes are hashed into a Merkle tree, and only the root goes on-chain through RecordAnchor.
 *
 * Leaf = keccak256(keccak256(abi.encode(uint8 kind, bytes32 value))), the OpenZeppelin "standard"
 * leaf shape. The kind tag lets seals, Council proposals, votes and results share one daily tree
 * (and one transaction) without one kind ever being mistaken for another.
 * Pairs are hashed sorted, so proofs verify with OpenZeppelin MerkleProof.verify.
 */

export const recordAnchorAbi = [
  {
    type: "event",
    name: "Anchored",
    inputs: [
      { name: "submitter", type: "address", indexed: true },
      { name: "root", type: "bytes32", indexed: true },
      { name: "count", type: "uint256", indexed: false },
      { name: "manifestDigest", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "function",
    name: "anchor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "count", type: "uint256" },
      { name: "manifestDigest", type: "bytes32" },
    ],
    outputs: [],
  },
  { type: "error", name: "EmptyBatch", inputs: [] },
  { type: "error", name: "ZeroRoot", inputs: [] },
] as const;

const SEAL_CODE = /^(0x)?[0-9a-fA-F]{64}$/;

/** Normalises a seal code to 0x-prefixed lowercase hex, or throws. */
export function toSealCode(code: string): Hex {
  if (!SEAL_CODE.test(code)) throw new Error("A seal code is 64 hexadecimal characters.");
  return `0x${code.replace(/^0x/i, "").toLowerCase()}`;
}

/** What a leaf records. Values are fixed forever: changing one would break old proofs. */
export const LeafKind = { seal: 1, proposal: 2, vote: 3, result: 4, set: 5, version: 6, draw: 7, certificate: 8, ledgerCheckpoint: 11, witnessChange: 12, memberVoice: 13, game: 14, beacon: 15, randomRequest: 16, beaconCommit: 17, beaconSecret: 18 } as const;
// Reserved, not yet in use: 9 agree-event, 10 evidence-package (docs/proof-receipt-design.md).
export type LeafKind = (typeof LeafKind)[keyof typeof LeafKind];

export function recordLeaf(kind: LeafKind, value: Hex): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [kind, value])));
}

export function sealLeaf(code: string): Hex {
  return recordLeaf(LeafKind.seal, toSealCode(code));
}

export function hashPair(a: Hex, b: Hex): Hex {
  return a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export interface SealTree {
  root: Hex;
  /** Leaves in manifest order (sorted, unique). */
  leaves: Hex[];
  /** keccak256 of every leaf in order: published on-chain so the batch can be rebuilt. */
  manifestDigest: Hex;
  proofs: Map<Hex, Hex[]>;
}

/** Builds the batch tree. Leaves are sorted and de-duplicated so the tree is deterministic. */
export function buildSealTree(inputLeaves: readonly Hex[]): SealTree {
  const leaves = [...new Set(inputLeaves.map((l) => l.toLowerCase() as Hex))].sort();
  if (leaves.length === 0) throw new Error("Cannot build a tree with no leaves.");

  const proofs = new Map<Hex, Hex[]>(leaves.map((l) => [l, []]));
  // Each node tracks which leaves sit under it, so siblings can be appended to their proofs.
  let level = leaves.map((h) => ({ h, under: [h] }));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (!right) {
        next.push(left); // odd one out moves up unchanged
        continue;
      }
      for (const l of left.under) proofs.get(l)!.push(right.h);
      for (const l of right.under) proofs.get(l)!.push(left.h);
      next.push({ h: hashPair(left.h, right.h), under: [...left.under, ...right.under] });
    }
    level = next;
  }
  return { root: level[0]!.h, leaves, manifestDigest: keccak256(concat(leaves)), proofs };
}

export function verifySealProof(code: string, proof: readonly Hex[], root: Hex): boolean {
  return verifyRecordProof(LeafKind.seal, toSealCode(code), proof, root);
}

/** Verifies a Merkle path for any leaf kind (seal, draw, vote…). */
export function verifyRecordProof(kind: LeafKind, value: Hex, proof: readonly Hex[], root: Hex): boolean {
  let h = recordLeaf(kind, value);
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
