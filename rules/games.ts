import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";

/**
 * Fair games for live events (bingo, raffles, prize wheels). VesTally runs the screen; it never
 * sells tickets or holds money.
 *
 * How a game stays fair, and why the call order stays hidden until each ball is called:
 *
 * 1. LOCK. When the host creates a game, VesTally makes a random secret (the seed) and records
 *    only this on the public record: keccak256(id, kind, settings, keccak256(seed), targetBlock).
 *    targetBlock is a BNB Chain block a little in the future.
 * 2. PLAY. Once targetBlock exists, the game's randomness is keccak256(seed, hash of targetBlock).
 *    The host couldn't know it (they never see the seed), and VesTally couldn't steer it (the
 *    block hash didn't exist when the seed was fixed). Balls, winners and spins all come from it.
 *    The seed stays secret during play, so nobody can work out the next ball.
 * 3. CHECK. When the game is finalized the seed is published. Anyone can confirm it matches the
 *    locked fingerprint and recompute every call, winner and spin.
 *
 * Bingo games made since the Ledger beacon go one better: each ball is drawn only when it's called,
 * mixing in a random number from the Ledger's witnesses (bingoDraw below), so not even VesTally,
 * which holds the seed, can see a ball coming.
 *
 * Bingo cards don't depend on the seed: card N of a game is fixed by the game ID and N, so cards
 * can be printed before the night and checked by anyone.
 */

export const GAME_KINDS = ["bingo", "raffle", "wheel"] as const;
export type GameKind = (typeof GAME_KINDS)[number];

/** Blocks between locking and the block whose hash is used (about 30–60 s on BNB Chain). */
export const GAME_DELAY_BLOCKS = 40n;
/** Blocks built on top of the target block before play can start, so a reorg can't swap it. */
export const GAME_CONFIRMATIONS = 15n;

export const commitOf = (seed: Hex): Hex => keccak256(seed);

/** The value recorded on the public record when a game is locked. `settings` is the exact published settings text. */
export function gameValue(g: { id: string; kind: GameKind; settings: string; commit: Hex; targetBlock: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
      [g.id, g.kind, keccak256(stringToBytes(g.settings)), g.commit, g.targetBlock],
    ),
  );
}

/** The game's randomness: only computable once the target block exists, and only by whoever has the seed. */
export function gameRandom(seed: Hex, blockHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [seed, blockHash]));
}

/** The i-th random number of a stream (`label` keeps bingo calls, raffle picks and spins apart). */
function nth(random: Hex, label: string, i: number): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "uint256" }], [random, label, BigInt(i)])));
}

// ---------------------------------------------------------------- bingo (75-ball)

export const BINGO_BALLS = 75;
export const MAX_BINGO_CARDS = 10_000;
export const bingoLetter = (n: number) => "BINGO"[Math.floor((n - 1) / 15)]!;

/** The full call order: a shuffle of 1..75 (Fisher–Yates driven by the game's randomness). */
export function bingoCallOrder(random: Hex): number[] {
  const balls = Array.from({ length: BINGO_BALLS }, (_, i) => i + 1);
  for (let i = balls.length - 1; i > 0; i--) {
    const j = Number(nth(random, "bingo-call", i) % BigInt(i + 1));
    [balls[i], balls[j]] = [balls[j]!, balls[i]!];
  }
  return balls;
}

/**
 * Ledger draws (games created with settings.draws = "ledger"): each ball is drawn when it's called,
 * from the game's randomness mixed with that call's Ledger beacon (see beacon.ts). Nobody,
 * VesTally included, can know a ball before its beacon exists. A ball drawn while the Ledger was
 * unreachable uses no beacon (null); the check then confirms no request for it is on the Ledger.
 */
export function gameDrawRequest(label: "bingo-draw" | "raffle-draw" | "wheel-draw", gameValue: Hex, k: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "uint256" }], [label, gameValue, BigInt(k)]));
}

export const bingoDrawRequest = (gameValue: Hex, k: number) => gameDrawRequest("bingo-draw", gameValue, k);

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const drawNumber = (random: Hex, label: string, k: number, beacon: Hex | null, extra = 0) =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "string" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
        [random, label, BigInt(k), beacon ?? ZERO32, BigInt(extra)],
      ),
    ),
  );

/**
 * Raffle with Ledger draws: prize number k (k = picked.length) goes to a ticket not yet picked,
 * from the game's randomness and the beacon of that reveal. "Reveal all" uses one beacon for
 * every remaining prize; k still differs for each.
 */
export function raffleDraw(random: Hex, picked: readonly number[], ticketCount: number, beacon: Hex | null): number {
  if (picked.length >= ticketCount) throw new Error("Every ticket has won.");
  const taken = new Set(picked);
  for (let extra = 0; ; extra++) {
    const idx = Number(drawNumber(random, "raffle-draw", picked.length, beacon, extra) % BigInt(ticketCount));
    if (!taken.has(idx)) return idx;
  }
}

/** Prize wheel with Ledger draws: where spin k lands. */
export function wheelDraw(random: Hex, k: number, segments: number, beacon: Hex | null): number {
  return Number(drawNumber(random, "wheel-draw", k, beacon) % BigInt(segments));
}

/** Ball number k (k = drawn.length): one of the balls not yet drawn. */
export function bingoDraw(random: Hex, drawn: readonly number[], beacon: Hex | null): number {
  const taken = new Set(drawn);
  const left = Array.from({ length: BINGO_BALLS }, (_, i) => i + 1).filter((n) => !taken.has(n));
  if (!left.length) throw new Error("Every ball has been drawn.");
  const x = BigInt(
    keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "uint256" }, { type: "bytes32" }], [random, "bingo-draw", BigInt(drawn.length), beacon ?? `0x${"00".repeat(32)}`]),
    ),
  );
  return left[Number(x % BigInt(left.length))]!;
}

/**
 * Card `n` of game `gameId`: 5 columns (B 1–15, I 16–30, N 31–45, G 46–60, O 61–75), 5 numbers
 * each, free square in the middle (0). Returned row by row: card[row][col].
 */
export function bingoCard(gameId: string, n: number): number[][] {
  const cols: number[][] = [];
  for (let c = 0; c < 5; c++) {
    const pool = Array.from({ length: 15 }, (_, i) => c * 15 + i + 1);
    const picked: number[] = [];
    for (let k = 0; k < 5; k++) {
      const r = BigInt(keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint32" }, { type: "uint8" }, { type: "uint8" }], [gameId, n, c, k])));
      picked.push(pool.splice(Number(r % BigInt(pool.length)), 1)[0]!);
    }
    cols.push(picked);
  }
  cols[2]![2] = 0;
  return Array.from({ length: 5 }, (_, r) => cols.map((col) => col[r]!));
}

/** A pattern is a list of shapes; a card wins when every square of any one shape is marked. Shapes are 25-bit masks, bit = row * 5 + col. */
export interface BingoPattern {
  id: string;
  name: string;
  shapes: number[];
}

const bit = (r: number, c: number) => 1 << (r * 5 + c);
const shape = (cells: [number, number][]) => cells.reduce((m, [r, c]) => m | bit(r, c), 0);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const ROWS = range(5).map((r) => shape(range(5).map((c) => [r, c])));
const COLS = range(5).map((c) => shape(range(5).map((r) => [r, c])));
const DIAG = [shape(range(5).map((i) => [i, i])), shape(range(5).map((i) => [i, 4 - i]))];

export const BINGO_PATTERNS: BingoPattern[] = [
  { id: "line", name: "Standard (any row, column or diagonal)", shapes: [...ROWS, ...COLS, ...DIAG] },
  { id: "coverall", name: "Coverall (the whole card)", shapes: [(1 << 25) - 1] },
  { id: "x", name: "X (both diagonals)", shapes: [DIAG[0]! | DIAG[1]!] },
  { id: "corners", name: "Four corners", shapes: [shape([[0, 0], [0, 4], [4, 0], [4, 4]])] },
  { id: "stamp", name: "Postage stamp (any 2×2 corner)", shapes: [[0, 0], [0, 3], [3, 0], [3, 3]].map(([r, c]) => shape([[r!, c!], [r!, c! + 1], [r! + 1, c!], [r! + 1, c! + 1]])) },
  { id: "frame", name: "Picture frame (the outside edge)", shapes: [ROWS[0]! | ROWS[4]! | COLS[0]! | COLS[4]!] },
  { id: "plus", name: "Plus sign", shapes: [ROWS[2]! | COLS[2]!] },
  { id: "t", name: "Letter T", shapes: [ROWS[0]! | COLS[2]!] },
  { id: "l", name: "Letter L", shapes: [COLS[0]! | ROWS[4]!] },
];

/** The pattern for a game: a built-in one, or a custom single shape (mask) drawn by the host. */
export function bingoPattern(id: string, customMask?: number): BingoPattern {
  if (id === "custom") {
    if (!customMask || customMask <= 0 || customMask >= 1 << 25) throw new Error("Draw the custom pattern first.");
    return { id: "custom", name: "Custom pattern", shapes: [customMask] };
  }
  const p = BINGO_PATTERNS.find((x) => x.id === id);
  if (!p) throw new Error("Unknown pattern.");
  return p;
}

/** Which squares of the card are marked by these calls (the free square always is). */
export function bingoMarks(card: number[][], called: Iterable<number>): number {
  const set = new Set(called);
  let m = 0;
  card.forEach((row, r) => row.forEach((n, c) => {
    if (n === 0 || set.has(n)) m |= bit(r, c);
  }));
  return m;
}

/** The shape that wins, or null. */
export function bingoWin(card: number[][], called: Iterable<number>, pattern: BingoPattern): number | null {
  const marks = bingoMarks(card, called);
  return pattern.shapes.find((s) => (marks & s) === s) ?? null;
}

// ---------------------------------------------------------------- raffle

export const MAX_RAFFLE_TICKETS = 1_000_000;
export const MAX_RAFFLE_PRIZES = 100;

/** Winning ticket positions (0-based, distinct), in prize order. */
export function raffleWinners(random: Hex, ticketCount: number, prizeCount: number): number[] {
  if (prizeCount > ticketCount) throw new Error("More prizes than tickets.");
  const chosen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; out.length < prizeCount; i++) {
    const idx = Number(nth(random, "raffle", i) % BigInt(ticketCount));
    if (chosen.has(idx)) continue;
    chosen.add(idx);
    out.push(idx);
  }
  return out;
}

// ---------------------------------------------------------------- prize wheel

export const MAX_WHEEL_SEGMENTS = 24;

/** Which segment spin `k` (0-based) lands on. Every segment is the same size. */
export function wheelSpin(random: Hex, k: number, segments: number): number {
  return Number(nth(random, "wheel", k) % BigInt(segments));
}

// ---------------------------------------------------------------- shared

/** Short game codes people can type: no 0/O, 1/I/L. */
export const GAME_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const GAME_CODE = /^[2-9A-HJKMNP-Z]{6}$/;
