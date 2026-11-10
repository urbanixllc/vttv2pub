import { bytesToHex, concat, encodeAbiParameters, hexToBytes, keccak256, sha256, stringToBytes, type Hex } from "viem";
import { canonicalJson } from "./council";
import { MAX_DRAW_ENTRIES, MAX_DRAW_WINNERS, drawRandomness, drawValue, normalizeEntry, pickWinners, type DrawTerms, type Winner } from "./draw";

/**
 * VesTally for Business: FairSelect and RecordProof commitments (docs/business/05, 06).
 *
 * Both commit to a list of private items (population members, or files) as a Merkle root over
 * SALTED leaves, made on the customer's device:
 *
 *   salt_i = keccak256(abi.encode(SALT_DOMAIN, secret, uint256 i))
 *   leaf_i = keccak256(abi.encode(MEMBER_DOMAIN, uint256 i, salt_i, itemHash_i))
 *   root   = sorted-pair Merkle root of leaf_0 … leaf_{n-1}, odd node promoted (the daily anchor's rules)
 *
 * - The position i is inside the leaf, so an item can't be moved after the fact.
 * - Each salt is secret until the customer discloses that one item, so the root (or another
 *   disclosed item) can't be used to confirm a guess about any undisclosed item.
 * - One `secret` per list keeps the receipt small; disclosing an item reveals only its own salt.
 *
 * FairSelect then locks a beacon Fair draw (draw.ts) whose fields carry the commitments:
 * entriesCode = population root, salt = keccak(abi.encode(SELECT_SALT_DOMAIN, rulesHash, nonce)).
 * The server, the Ledger, the beacon and the anchor are reused unchanged.
 *
 * RecordProof seals the root of a set of files as an ordinary seal code (kind 1), so nothing
 * about the files, not even their fingerprints, appears on the public record.
 */

const d = (s: string) => keccak256(stringToBytes(s));
export const FAIRSELECT_MEMBER_DOMAIN = d("vestally-fairselect-member-v1");
export const FAIRSELECT_SALT_DOMAIN = d("vestally-fairselect-member-salt-v1");
export const FAIRSELECT_SELECTION_DOMAIN = d("vestally-fairselect-salt-v1");
export const RECORDPROOF_MEMBER_DOMAIN = d("vestally-recordproof-file-v1");
export const RECORDPROOF_SALT_DOMAIN = d("vestally-recordproof-file-salt-v1");

export const FAIRSELECT_RULES_SPEC = "vestally-fairselect-rules-v1";
export const FAIRSELECT_MAX_POPULATION = MAX_DRAW_ENTRIES;
export const FAIRSELECT_MAX_SAMPLE = MAX_DRAW_WINNERS;
export const RECORDPROOF_MAX_FILES = 10_000;

export interface SaltedDomains {
  member: Hex;
  salt: Hex;
}
export const FAIRSELECT_DOMAINS: SaltedDomains = { member: FAIRSELECT_MEMBER_DOMAIN, salt: FAIRSELECT_SALT_DOMAIN };
export const RECORDPROOF_DOMAINS: SaltedDomains = { member: RECORDPROOF_MEMBER_DOMAIN, salt: RECORDPROOF_SALT_DOMAIN };

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const isHash = (h: unknown): h is Hex => typeof h === "string" && HEX32.test(h);

export function itemSalt(dom: SaltedDomains, secret: Hex, index: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [dom.salt, secret, BigInt(index)]));
}

export function itemLeaf(dom: SaltedDomains, index: number, salt: Hex, itemHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }], [dom.member, BigInt(index), salt, itemHash]));
}

/** SHA-256 of a member's identifier after the Fair draw normalization (invisible characters, spaces). */
export function memberHash(member: string): Hex {
  return sha256(stringToBytes(normalizeEntry(member)));
}

function less(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/**
 * A Merkle tree that keeps its leaves in order and gives any leaf's path on demand. Levels are
 * kept as raw bytes, so a million leaves fit comfortably in a browser.
 */
export class SaltedTree {
  readonly levels: Uint8Array[][];
  constructor(leaves: readonly Hex[]) {
    if (!leaves.length) throw new Error("Nothing to commit to.");
    let level = leaves.map((l) => hexToBytes(l));
    this.levels = [level];
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const a = level[i]!;
        const b = level[i + 1];
        if (!b) next.push(a);
        else next.push(keccak256(less(a, b) ? concat([a, b]) : concat([b, a]), "bytes"));
      }
      this.levels.push(next);
      level = next;
    }
  }
  get root(): Hex {
    return bytesToHex(this.levels.at(-1)![0]!);
  }
  get count(): number {
    return this.levels[0]!.length;
  }
  leaf(index: number): Hex {
    return bytesToHex(this.levels[0]![index]!);
  }
  proof(index: number): Hex[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new Error("No such position.");
    const path: Hex[] = [];
    let i = index;
    for (let l = 0; l < this.levels.length - 1; l++) {
      const level = this.levels[l]!;
      const sib = i ^ 1;
      if (sib < level.length) path.push(bytesToHex(level[sib]!));
      i >>= 1;
    }
    return path;
  }
}

/** Walks a sorted-pair Merkle path (the same rule as the daily anchor and verify-proof.mjs). */
export function walkPath(leaf: Hex, path: readonly Hex[]): Hex {
  let h = leaf.toLowerCase() as Hex;
  for (const p of path) {
    const q = p.toLowerCase() as Hex;
    h = keccak256(h < q ? concat([h, q]) : concat([q, h]));
  }
  return h;
}

export interface Disclosure {
  index: number;
  /** FairSelect: the member's identifier as committed. RecordProof uses `itemHash` (the file's SHA-256) instead. */
  member?: string;
  itemHash?: Hex;
  salt: Hex;
  path: Hex[];
}

/** Does this disclosed item sit at its position in the committed list? */
export function checkDisclosure(dom: SaltedDomains, root: Hex, x: Disclosure): boolean {
  if (!Number.isInteger(x.index) || x.index < 0 || !isHash(x.salt) || !Array.isArray(x.path) || !x.path.every(isHash)) return false;
  const h = x.itemHash ?? (typeof x.member === "string" ? memberHash(x.member) : null);
  if (!h || !isHash(h)) return false;
  return walkPath(itemLeaf(dom, x.index, x.salt, h), x.path).toLowerCase() === root.toLowerCase();
}

export function newSecret(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Builds the salted tree over item hashes. `onProgress` is called every few thousand items so a
 * page can show progress; `yieldEvery` lets a browser stay responsive on long lists.
 */
export async function buildSaltedTree(
  dom: SaltedDomains,
  secret: Hex,
  itemHashes: readonly Hex[],
  onProgress?: (done: number, total: number) => void,
): Promise<SaltedTree> {
  const leaves: Hex[] = new Array(itemHashes.length);
  for (let i = 0; i < itemHashes.length; i++) {
    leaves[i] = itemLeaf(dom, i, itemSalt(dom, secret, i), itemHashes[i]!);
    if (i % 5000 === 4999) {
      onProgress?.(i + 1, itemHashes.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(itemHashes.length, itemHashes.length);
  return new SaltedTree(leaves);
}

export function discloseItem(dom: SaltedDomains, tree: SaltedTree, secret: Hex, index: number, item: { member: string } | { itemHash: Hex }): Disclosure {
  return { index, ...item, salt: itemSalt(dom, secret, index), path: tree.proof(index) };
}

// ---------------------------------------------------------------- FairSelect rules and lock

export type FairSelectMethod = "simple-random-without-replacement";

export interface FairSelectRules {
  spec: typeof FAIRSELECT_RULES_SPEC;
  method: FairSelectMethod;
  populationRoot: Hex;
  populationCount: number;
  sampleSize: number;
  /** "file": the order the list was given in. "sorted": sorted by member identifier first. */
  order: "file" | "sorted";
  /** SHA-256 of the identifying column's name; the plain name stays with the customer. */
  memberField?: Hex;
  /** Seal code of the exported source report the population came from. */
  sourceSeal?: Hex;
  /** SHA-256 of the customer's own notes (scope, exclusions). The notes stay with the customer. */
  notesHash?: Hex;
  randomness: { ledgerBeacon: true; target: "bnb-block+100" };
}

export function checkRules(r: FairSelectRules): string | null {
  if (r.spec !== FAIRSELECT_RULES_SPEC) return "Unknown rules version.";
  if (r.method !== "simple-random-without-replacement") return "Unknown selection method.";
  if (!isHash(r.populationRoot)) return "Malformed population fingerprint.";
  if (!Number.isInteger(r.populationCount) || r.populationCount < 1 || r.populationCount > FAIRSELECT_MAX_POPULATION)
    return `A population has 1 to ${FAIRSELECT_MAX_POPULATION.toLocaleString("en-US")} members.`;
  if (!Number.isInteger(r.sampleSize) || r.sampleSize < 1 || r.sampleSize > Math.min(r.populationCount, FAIRSELECT_MAX_SAMPLE))
    return `Choose a sample of 1 to ${Math.min(r.populationCount, FAIRSELECT_MAX_SAMPLE).toLocaleString("en-US")}.`;
  if (r.order !== "file" && r.order !== "sorted") return "Unknown order.";
  for (const h of [r.memberField, r.sourceSeal, r.notesHash]) if (h !== undefined && !isHash(h)) return "Malformed fingerprint in the rules.";
  if (r.randomness?.ledgerBeacon !== true || r.randomness?.target !== "bnb-block+100") return "Unknown randomness rule.";
  return null;
}

export function rulesHash(r: FairSelectRules): Hex {
  return sha256(stringToBytes(canonicalJson(r)));
}

export function selectionSalt(rules: Hex, nonce: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [FAIRSELECT_SELECTION_DOMAIN, rules, nonce]));
}

/** The Fair draw terms a FairSelect selection locks (sent to /draws exactly as a draw's are). */
export function selectionTerms(r: FairSelectRules, nonce: Hex): DrawTerms {
  const why = checkRules(r);
  if (why) throw new Error(why);
  return { entriesCode: r.populationRoot, entryCount: r.populationCount, winnerCount: r.sampleSize, salt: selectionSalt(rulesHash(r), nonce), beacon: true };
}

export function selectionValue(r: FairSelectRules, nonce: Hex): Hex {
  return drawValue(selectionTerms(r, nonce));
}

/** The sample: positions in the committed population, from the BNB block hash and the Ledger beacon. */
export function pickSelection(value: Hex, bnbBlockHash: Hex, beacon: Hex, populationCount: number, sampleSize: number): Winner[] {
  return pickWinners(value, drawRandomness(bnbBlockHash, beacon), populationCount, sampleSize);
}

/** Members in committed order: as given, or sorted by identifier (code-point order, so every machine agrees). */
export function orderMembers(members: readonly string[], order: FairSelectRules["order"]): string[] {
  const list = members.map(normalizeEntry);
  return order === "sorted" ? [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : list;
}

/** Duplicate identifiers (after normalization), which a population must not have. */
export function duplicateMembers(members: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of members) (seen.has(m) ? dup : seen).add(m);
  return [...dup];
}
