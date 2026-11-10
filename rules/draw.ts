import { encodeAbiParameters, keccak256, sha256, stringToBytes, type Hex } from "viem";
import { LeafKind, recordLeaf } from "./seal";

/**
 * Fair draws: provably fair winner selection that VesTally never runs.
 *
 * 1. LOCK. The organizer's browser fixes the entry list, and only this goes on the public record:
 *    keccak256(entriesCode, entryCount, winnerCount, salt). The salt is a public random number
 *    that keeps two draws over the same list apart. Nothing about the draw is secret.
 * 2. WAIT. Once that lock is recorded in block B, the randomness is the hash of block B + 100,
 *    which didn't exist when the entries were fixed. The result is only shown once that block has
 *    DRAW_CONFIRMATIONS blocks on top of it, so a reorg can't swap it.
 * 3. DRAW. Winner k comes from keccak256(abi.encode(drawValue, blockHash, k)) mod entryCount,
 *    skipping entries already picked. Everything in it is public, so anyone can compute the
 *    winners the moment the block is final. The organizer has nothing to reveal or withhold:
 *    walking away from a bad result changes nothing, because the result is already public.
 *
 * Draws locked with `beacon: true` (all new ones) also mix in a random number from the VesTally
 * Ledger's witnesses (beacon.ts), requested the moment the draw is locked: winners come from
 * keccak256(blockHash, beacon). Steering the result then takes both a BNB Chain validator and
 * every Ledger witness, and the check confirms the request was on the Ledger before the BNB block.
 *
 * What it doesn't stop: an organizer who locks several versions of a draw and only shares the one
 * they like (the draw page counts look-alike locks and shows when the random block was made, so
 * entrants can check they got the link before it), and, in theory, the producer of block B + 100
 * trying to steer its hash, which takes a validator who knows about the draw and cares about it.
 */

/** Blocks between the lock's record and the block whose hash is used. ~75 s on BSC. */
export const DRAW_DELAY_BLOCKS = 100n;
/** Blocks that must be built on top of the randomness block before the result is shown. */
export const DRAW_CONFIRMATIONS = 15n;
export const MAX_DRAW_ENTRIES = 1_000_000;
export const MAX_DRAW_WINNERS = 1_000;

/**
 * One entry per line. Invisible characters (zero-width spaces, control characters) are removed and
 * runs of spaces become one, so two entries that look the same are the same. Blank lines are
 * ignored and order is kept.
 */
export function normalizeEntry(line: string): string {
  return line
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeEntries(text: string): string[] {
  return text.split(/\r?\n|\r/).map(normalizeEntry).filter(Boolean);
}

/** Longest entry allowed, in characters. */
export const MAX_ENTRY_LENGTH = 200;

/** SHA-256 of the normalized entries joined by "\n" (UTF-8). */
export function entriesCode(entries: readonly string[]): Hex {
  return sha256(stringToBytes(entries.join("\n")));
}

export interface DrawTerms {
  entriesCode: Hex;
  entryCount: number;
  winnerCount: number;
  /** Public random number chosen at lock time, so identical lists still make different draws. */
  salt: Hex;
  /** Also use the Ledger beacon (part of the locked value, so it can't be switched on or off later). */
  beacon?: boolean;
}

export function checkTerms(t: DrawTerms): void {
  if (!Number.isInteger(t.entryCount) || t.entryCount < 1 || t.entryCount > MAX_DRAW_ENTRIES)
    throw new Error(`A draw needs 1 to ${MAX_DRAW_ENTRIES.toLocaleString("en-US")} entries.`);
  if (!Number.isInteger(t.winnerCount) || t.winnerCount < 1 || t.winnerCount > Math.min(t.entryCount, MAX_DRAW_WINNERS))
    throw new Error("Choose between 1 winner and the number of entries (at most 1,000).");
  for (const h of [t.entriesCode, t.salt]) if (!/^0x[0-9a-f]{64}$/i.test(h)) throw new Error("Malformed draw hash.");
}

/** The value that goes on the public record when a draw is locked. */
export function drawValue(t: DrawTerms): Hex {
  checkTerms(t);
  if (t.beacon)
    return keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint32" }, { type: "uint32" }, { type: "bytes32" }, { type: "string" }],
        [t.entriesCode, t.entryCount, t.winnerCount, t.salt, "ledger-beacon-v1"],
      ),
    );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint32" }, { type: "uint32" }, { type: "bytes32" }],
      [t.entriesCode, t.entryCount, t.winnerCount, t.salt],
    ),
  );
}

/** The Ledger randomness request a beacon draw makes when it's locked. */
export function drawBeaconRequest(value: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["draw-beacon", value]));
}

/** A beacon draw's randomness: the BNB Chain block hash mixed with the Ledger beacon. */
export function drawRandomness(blockHash: Hex, beacon: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [blockHash, beacon]));
}

export function drawLeaf(t: DrawTerms): Hex {
  return recordLeaf(LeafKind.draw, drawValue(t));
}

export interface Winner {
  /** 1st, 2nd, … winner */
  place: number;
  /** 0-based position in the entry list */
  index: number;
  /** The counter that produced this pick (picks of an already-chosen entry are skipped). */
  nonce: number;
}

/** Picks winners from the locked draw code and the block hash. Deterministic: anyone gets the same list. */
export function pickWinners(value: Hex, blockHash: Hex, entryCount: number, winnerCount: number): Winner[] {
  if (winnerCount > entryCount) throw new Error("More winners than entries.");
  const chosen = new Set<number>();
  const winners: Winner[] = [];
  const n = BigInt(entryCount);
  for (let nonce = 0; winners.length < winnerCount; nonce++) {
    const r = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [value, blockHash, BigInt(nonce)])));
    const index = Number(r % n);
    if (chosen.has(index)) continue;
    chosen.add(index);
    winners.push({ place: winners.length + 1, index, nonce });
  }
  return winners;
}
