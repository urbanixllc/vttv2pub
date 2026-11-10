import { encodeAbiParameters, getAddress, keccak256, recoverMessageAddress, stringToBytes, type Address, type Hex } from "viem";

/**
 * VesTally Blockchain Ledger randomness beacon: random numbers nobody can know in advance, made by
 * the witnesses. See docs/vtt-ledger-design.md ("Randomness beacon").
 *
 * - COMMIT. A witness makes a hash chain once: a secret s0, then s1 = keccak(s0), … up to sN (the
 *   "top"). It signs and publishes only the top. Reveal number i is s(N−i), so each reveal hashes to
 *   the one before it (and reveal 1 hashes to the top). There is exactly one valid next value, so a
 *   witness can't shop for a better one; it can only reveal or stay silent.
 * - REQUEST. Something that needs a random number (a bingo ball) puts a kind-16 record on the
 *   Ledger. The block that holds it is a request block.
 * - REVEAL. Witnesses that see a request block send their next reveal. The sequencer doesn't know
 *   them in advance, and a witness never sees what the number will be used with (a game's secret).
 * - SECRET. The request block also carries a kind-18 record: the hash of a fresh sequencer secret.
 *   Witnesses can't know the secret while they decide whether to reveal, so even a lone witness
 *   can't work out which choice would help it. The sequencer fixed the secret before any reveal
 *   existed, so it can't fit the secret to the reveals either.
 * - BEACON. A few seconds later the sequencer closes the request: the beacon value mixes the block
 *   hash, the secret and every reveal received, and a kind-15 record of it goes into a later block.
 *
 * Every reveal the sequencer accepts gets a signed receipt. A witness checks its reveal made it in;
 * if it was left out, the receipt proves it to anyone.
 */

const BEACON_DOMAIN = keccak256(stringToBytes("VesTally Blockchain Ledger beacon v1"));
/** v2 beacons also mix in the sequencer's sealed secret. v1 beacons (before it existed) still check. */
const BEACON_DOMAIN_V2 = keccak256(stringToBytes("VesTally Blockchain Ledger beacon v2"));
const SECRET_DOMAIN = keccak256(stringToBytes("VesTally Blockchain Ledger beacon secret v1"));
/** Most reveals a witness can skip between two accepted ones (sent but lost, for example). */
export const BEACON_MAX_GAP = 10_000;
/** Reveals in a witness's chain: years of bingo nights. A new chain starts itself when one runs low. */
export const BEACON_CHAIN_LENGTH = 100_000;
const ZERO = `0x${"00".repeat(32)}` as Hex;

export interface BeaconReveal {
  witness: Address;
  index: number;
  value: Hex;
  /** The witness's previous accepted reveal (index 0 = its commitment's top), so anyone can check this one links to it. */
  prev: { index: number; value: Hex };
}

export interface BeaconCommitment {
  witness: Address;
  top: Hex;
  length: number;
  /** Unix ms when the witness made it: a later commitment replaces an earlier one. */
  time: number;
  signature: Hex;
  /** Set by the sequencer: the first block whose requests this commitment can answer. Not signed. */
  fromHeight?: number;
}

export interface Beacon {
  /** The request block. */
  height: number;
  blockHash: Hex;
  reveals: BeaconReveal[];
  /** The sequencer's secret, published when the beacon closes. Its hash is the request block's kind-18 record. Absent on v1 beacons. */
  secret?: Hex;
  value: Hex;
}

export const beaconCommitMessage = (witness: Address, top: Hex, length: number, time: number) =>
  `VesTally beacon commitment\nWitness: ${getAddress(witness)}\nTop: ${top.toLowerCase()}\nLength: ${length}\nTime: ${time}`;

/** Who signed a commitment, or null. */
export async function beaconCommitSigner(c: Omit<BeaconCommitment, "signature"> & { signature: Hex }): Promise<Address | null> {
  try {
    return await recoverMessageAddress({ message: beaconCommitMessage(c.witness, c.top, c.length, c.time), signature: c.signature });
  } catch {
    return null;
  }
}

/** The kind-17 record for a commitment. */
export function beaconCommitValue(c: Pick<BeaconCommitment, "witness" | "top" | "length" | "time">): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }], [getAddress(c.witness), c.top, BigInt(c.length), BigInt(c.time)]),
  );
}

/** keccak applied `steps` times. */
export function hashSteps(value: Hex, steps: number): Hex {
  let v = value;
  for (let i = 0; i < steps; i++) v = keccak256(v);
  return v;
}

/** Does this reveal link to the witness's previous one (no more than BEACON_MAX_GAP steps on)? */
export function revealLinks(r: Pick<BeaconReveal, "index" | "value" | "prev">): boolean {
  const steps = r.index - r.prev.index;
  if (!Number.isInteger(steps) || steps < 1 || steps > BEACON_MAX_GAP) return false;
  return hashSteps(r.value, steps).toLowerCase() === r.prev.value.toLowerCase();
}

/** Reveals in a fixed order (by witness address), so the beacon doesn't depend on arrival order. */
const sorted = (reveals: readonly Pick<BeaconReveal, "witness" | "index" | "value">[]) =>
  [...reveals].sort((a, b) => (a.witness.toLowerCase() < b.witness.toLowerCase() ? -1 : 1));

/** The beacon value for a request block. With no reveals it's still defined, but then only as unpredictable as the sequencer. */
export function beaconValue(height: number, blockHash: Hex, reveals: readonly Pick<BeaconReveal, "witness" | "index" | "value">[], secret?: Hex): Hex {
  const r = sorted(reveals);
  const list = [r.map((x) => getAddress(x.witness)), r.map((x) => BigInt(x.index)), r.map((x) => x.value)] as const;
  if (secret === undefined)
    return keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "address[]" }, { type: "uint64[]" }, { type: "bytes32[]" }],
        [BEACON_DOMAIN, BigInt(height), blockHash, ...list],
      ),
    );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address[]" }, { type: "uint64[]" }, { type: "bytes32[]" }],
      [BEACON_DOMAIN_V2, BigInt(height), blockHash, secret, ...list],
    ),
  );
}

/** The kind-18 record in a request block: a commitment to the sequencer's secret for that block. */
export function beaconSecretCommit(secret: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [SECRET_DOMAIN, secret]));
}

/**
 * Checks a beacon against its request block: a v2 beacon's secret must match the block's kind-18
 * commitment, and a block that carries a commitment must have a v2 beacon (no dropping the secret).
 */
export function beaconMatchesBlock(b: Pick<Beacon, "secret" | "blockHash">, block: { hash: Hex; records: readonly { kind: number; value: Hex }[] }): string | null {
  if (block.hash.toLowerCase() !== b.blockHash.toLowerCase()) return "The beacon names a different request block.";
  const commits = block.records.filter((r) => r.kind === 18);
  if (b.secret === undefined) return commits.length ? "The request block holds a sealed secret, but the beacon doesn't use it." : null;
  if (commits.length !== 1) return "The request block doesn't hold exactly one sealed secret.";
  return commits[0]!.value.toLowerCase() === beaconSecretCommit(b.secret).toLowerCase() ? null : "The beacon's secret doesn't match the one sealed in its request block.";
}

/** What the sequencer signs when it accepts a reveal. A witness holding one can prove its reveal was taken. */
export const beaconReceiptMessage = (height: number, witness: Address, index: number, value: Hex) =>
  `VesTally beacon reveal accepted\nBlock: ${height}\nWitness: ${getAddress(witness)}\nIndex: ${index}\nValue: ${value.toLowerCase()}`;

/** Who signed a reveal receipt, or null. */
export async function beaconReceiptSigner(r: { height: number; witness: Address; index: number; value: Hex; receipt: Hex }): Promise<Address | null> {
  try {
    return await recoverMessageAddress({ message: beaconReceiptMessage(r.height, r.witness, r.index, r.value), signature: r.receipt });
  } catch {
    return null;
  }
}

/** The kind-15 record that puts a closed beacon on the Ledger. */
export function beaconRecordValue(b: Pick<Beacon, "height" | "value">): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }], [BigInt(b.height), b.value]));
}

/** Checks a published beacon on its own: the value matches its reveals and every reveal links to the one before it. */
export function checkBeacon(b: Beacon): string | null {
  if (beaconValue(b.height, b.blockHash, b.reveals, b.secret).toLowerCase() !== b.value.toLowerCase()) return `The beacon for block ${b.height} doesn't match its reveals.`;
  const seen = new Set<string>();
  for (const r of b.reveals) {
    if (seen.has(r.witness.toLowerCase())) return `Witness ${r.witness} appears twice in the beacon for block ${b.height}.`;
    seen.add(r.witness.toLowerCase());
    if (!revealLinks(r)) return `Witness ${r.witness}'s reveal for block ${b.height} doesn't link to its previous one.`;
  }
  return null;
}

/**
 * A witness's hash chain. Only the secret is stored; checkpoints every 1,000 steps are rebuilt in
 * memory (about 100,000 hashes once, well under a second), so any reveal takes under 1,000 hashes.
 */
export class RevealChain {
  private readonly checkpoints: Hex[] = [];
  readonly top: Hex;
  constructor(
    readonly secret: Hex,
    readonly length: number = BEACON_CHAIN_LENGTH,
  ) {
    let v = secret;
    for (let k = 0; k < length; k++) {
      if (k % 1000 === 0) this.checkpoints.push(v);
      v = keccak256(v);
    }
    this.top = v;
  }
  /** Reveal number i (1..length): s(length − i). */
  reveal(i: number): Hex {
    if (!Number.isInteger(i) || i < 1 || i > this.length) throw new Error(`Reveal ${i} is outside this chain.`);
    const k = this.length - i;
    return hashSteps(this.checkpoints[Math.floor(k / 1000)]!, k % 1000);
  }
}

export const NO_BEACON = ZERO;
