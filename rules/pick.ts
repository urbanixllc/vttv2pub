import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { MAX_ENTRY_LENGTH, normalizeEntry, pickWinners, type Winner } from "./draw";

/**
 * Fair picks: instant winner picks (the Discord /fairpick command) from the VesTally Ledger
 * beacon alone, so the result arrives in a second or two instead of after a BNB Chain block.
 *
 * 1. The entries are fixed in the command. Only their fingerprint, the counts and a public salt
 *    make up the pick's value. VesTally never stores the entries: the proof link carries them in
 *    its #fragment, which browsers don't send to any server.
 * 2. The pick asks the Ledger for randomness (request = pickRequest(value)). The witnesses'
 *    values are unknown to everyone in advance, VesTally included.
 * 3. Winners = pickWinners(value, beacon, …), the same formula as Fair draws, so anyone can
 *    recompute them from the entries, the salt and the beacon.
 *
 * Trust: steering a pick would take VesTally and every witness that added randomness, together.
 * Re-running the command on the same list makes a new pick; the bot says how many times a list
 * has been picked, so a re-roll is visible in the channel.
 */

export const MAX_PICK_ENTRIES = 500;
export const MAX_PICK_WINNERS = 50;

export interface PickTerms {
  entriesCode: Hex;
  entryCount: number;
  winnerCount: number;
  salt: Hex;
}

/** Entries typed into one line: split on commas, semicolons or new lines; mentions on spaces too. */
export function parsePickEntries(text: string): { entries: string[]; duplicates: number } {
  const parts = text.split(/[,;\n\r]+/).flatMap((p) => (/^(\s*<@[!&]?\d+>\s*)+$/.test(p) ? (p.match(/<@[!&]?\d+>/g) ?? []) : [p]));
  const seen = new Set<string>();
  const entries: string[] = [];
  let duplicates = 0;
  for (const p of parts) {
    const e = normalizeEntry(p).slice(0, MAX_ENTRY_LENGTH);
    if (!e) continue;
    const key = e.replace(/^<@!/, "<@").toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    entries.push(e);
  }
  return { entries, duplicates };
}

export function pickValue(t: PickTerms): Hex {
  if (!Number.isInteger(t.entryCount) || t.entryCount < 1 || t.entryCount > MAX_PICK_ENTRIES) throw new Error(`A pick needs 1 to ${MAX_PICK_ENTRIES} entries.`);
  if (!Number.isInteger(t.winnerCount) || t.winnerCount < 1 || t.winnerCount > Math.min(t.entryCount, MAX_PICK_WINNERS))
    throw new Error(`Pick between 1 and ${Math.min(t.entryCount, MAX_PICK_WINNERS)} winners.`);
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint32" }, { type: "uint32" }, { type: "bytes32" }, { type: "string" }],
      [t.entriesCode, t.entryCount, t.winnerCount, t.salt, "fair-pick-v1"],
    ),
  );
}

/** The Ledger randomness request a pick makes. */
export function pickRequest(value: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["fair-pick", value]));
}

export function pickFromBeacon(value: Hex, beacon: Hex, entryCount: number, winnerCount: number): Winner[] {
  return pickWinners(value, beacon, entryCount, winnerCount);
}

/** The proof link's #fragment: the entries, kept out of every server log. */
export function pickFragment(entries: readonly string[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function readPickFragment(fragment: string): string[] | null {
  try {
    const b64 = fragment.replace(/^#?e=/, "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const list = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as unknown;
    return Array.isArray(list) && list.every((x) => typeof x === "string") ? (list as string[]) : null;
  } catch {
    return null;
  }
}
