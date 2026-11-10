import { hashTypedData, keccak256, stringToBytes, type Address, type Hex, type TypedDataDomain } from "viem";

/**
 * VTT Council: gasless voting with signed messages (EIP-712).
 *
 * - A proposal is signed by an allowed proposer. Its EIP-712 hash is the proposal ID, and it goes on
 *   the public record as a kind-2 leaf.
 * - A vote is a signature from a holder over { proposalId, choice, nonce }. Voting power is the
 *   holder's VTT balance at the proposal's snapshot block, so buying after the proposal opens adds
 *   nothing. A newer vote from the same address replaces the older one.
 * - The result lists every vote with its signature and power, plus the signed proposal and the
 *   wallets that count as zero, so anyone can recount it from scratch. Its hash (over canonical
 *   JSON, so storage can't change it) goes on the public record as a kind-4 leaf.
 * - Signatures are bound to the chain and, when set, to one deployment (verifyingContract), so a
 *   vote for one copy of the Council can't be replayed on another.
 */

export const VoteType = { yesNoAbstain: 0, singleChoice: 1 } as const;
export type VoteType = (typeof VoteType)[keyof typeof VoteType];
export const YES_NO_ABSTAIN = ["Yes", "No", "Abstain"] as const;

export const MAX_TITLE = 120;
export const MAX_BODY = 20_000;
export const MAX_OPTIONS = 10;

export function councilDomain(chainId: number, verifyingContract?: Address | null): TypedDataDomain {
  return verifyingContract ? { name: "VesTally Council", version: "1", chainId, verifyingContract } : { name: "VesTally Council", version: "1", chainId };
}

export const proposalTypes = {
  Proposal: [
    { name: "title", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "options", type: "string[]" },
    { name: "voteType", type: "uint8" },
    { name: "snapshotBlock", type: "uint64" },
    { name: "startsAt", type: "uint64" },
    { name: "endsAt", type: "uint64" },
  ],
} as const;

export const voteTypes = {
  Vote: [
    { name: "proposalId", type: "bytes32" },
    { name: "choice", type: "uint8" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/**
 * A holder's proposal submission: a draft sent to the team for review. It is not a proposal and
 * nothing goes on the public record; the signature only proves the sender holds the wallet.
 */
export const submissionTypes = {
  ProposalSubmission: [
    { name: "title", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "options", type: "string[]" },
    { name: "voteType", type: "uint8" },
    { name: "time", type: "uint64" },
  ],
} as const;

export interface SubmissionMessage {
  title: string;
  bodyHash: Hex;
  options: string[];
  voteType: VoteType;
  /** unix milliseconds */
  time: bigint;
}

export interface ProposalMessage {
  title: string;
  bodyHash: Hex;
  options: string[];
  voteType: VoteType;
  snapshotBlock: bigint;
  /** unix seconds */
  startsAt: bigint;
  endsAt: bigint;
}

export interface VoteMessage {
  proposalId: Hex;
  choice: number;
  /** unix milliseconds when signed; the newest vote from an address counts */
  nonce: bigint;
}

export const bodyHash = (body: string): Hex => keccak256(stringToBytes(body.normalize("NFC")));

export function proposalId(chainId: number, p: ProposalMessage, verifyingContract?: Address | null): Hex {
  return hashTypedData({ domain: councilDomain(chainId, verifyingContract), types: proposalTypes, primaryType: "Proposal", message: p });
}

/** Rules every proposal must meet. Returns a reason, or null if it's fine. */
export function checkProposal(p: ProposalMessage, body: string): string | null {
  if (!p.title.trim() || p.title.length > MAX_TITLE) return `The title must be 1 to ${MAX_TITLE} characters.`;
  if (body.length > MAX_BODY) return `The proposal text can be up to ${MAX_BODY.toLocaleString("en-US")} characters.`;
  if (bodyHash(body) !== p.bodyHash) return "The proposal text doesn't match what was signed.";
  if (p.voteType === VoteType.yesNoAbstain) {
    if (p.options.join("|") !== YES_NO_ABSTAIN.join("|")) return "A yes/no vote has the options Yes, No, Abstain.";
  } else if (p.voteType === VoteType.singleChoice) {
    if (p.options.length < 2 || p.options.length > MAX_OPTIONS) return `Give 2 to ${MAX_OPTIONS} options.`;
    if (p.options.some((o) => !o.trim() || o.length > 80)) return "Each option must be 1 to 80 characters.";
    if (new Set(p.options.map((o) => o.trim().toLowerCase())).size !== p.options.length) return "Options must be different.";
  } else return "Unknown vote type.";
  if (p.endsAt <= p.startsAt) return "Voting must end after it starts.";
  if (p.endsAt - p.startsAt < 3_600n) return "Voting must stay open for at least an hour.";
  if (p.endsAt - p.startsAt > 60n * 86_400n) return "Voting can stay open for at most 60 days.";
  return null;
}

export interface CountedVote {
  voter: Address;
  choice: number;
  nonce: string;
  signature: Hex;
  /** raw token units at the snapshot block */
  power: string;
}

export interface Tally {
  /** raw token units per option */
  totals: string[];
  /** votes per option */
  voters: number[];
  totalPower: string;
  totalVoters: number;
}

/** Sums voting power per option. Only the newest vote per address counts. */
export function tally(optionCount: number, votes: readonly CountedVote[]): Tally {
  const latest = new Map<string, CountedVote>();
  for (const v of votes) {
    const key = v.voter.toLowerCase();
    const prev = latest.get(key);
    if (!prev || BigInt(v.nonce) > BigInt(prev.nonce)) latest.set(key, v);
  }
  const totals = new Array<bigint>(optionCount).fill(0n);
  const voters = new Array<number>(optionCount).fill(0);
  let totalPower = 0n;
  for (const v of latest.values()) {
    if (v.choice < 0 || v.choice >= optionCount) continue;
    totals[v.choice]! += BigInt(v.power);
    voters[v.choice]! += 1;
    totalPower += BigInt(v.power);
  }
  return { totals: totals.map(String), voters, totalPower: totalPower.toString(), totalVoters: latest.size };
}

/** The signed proposal, as it appears in a result. Numbers are decimal strings. */
export interface ResultProposal {
  title: string;
  bodyHash: Hex;
  options: string[];
  voteType: number;
  snapshotBlock: string;
  startsAt: string;
  endsAt: string;
  proposer: Address;
  signature: Hex;
}

/** What a recounter needs besides the votes: whose balances count, and which wallets count as zero. */
export interface ResultContext {
  verifyingContract?: Address | null;
  token?: Address | null;
  /** Wallets whose balance counts as zero (team, charity, burn, pools). */
  excluded?: readonly Address[];
  /** The proposal exactly as signed, so the ID can be rebuilt. */
  proposal?: ResultProposal | null;
}

/** The published result. Its hash goes on the public record. */
export interface CouncilResult {
  kind: "vestally-council-result";
  version: 2;
  chainId: number;
  verifyingContract: Address | null;
  proposalId: Hex;
  proposal: ResultProposal | null;
  snapshotBlock: string;
  token: Address | null;
  excluded: Address[];
  options: string[];
  tally: Tally;
  /** Every counted vote, sorted by voter, with its signature and power: anyone can recount. */
  votes: CountedVote[];
}

/** Turns a result's proposal back into the signed message. */
export function proposalMessage(p: ResultProposal): ProposalMessage {
  return {
    title: p.title,
    bodyHash: p.bodyHash,
    options: p.options,
    voteType: p.voteType as VoteType,
    snapshotBlock: BigInt(p.snapshotBlock),
    startsAt: BigInt(p.startsAt),
    endsAt: BigInt(p.endsAt),
  };
}

export function buildResult(
  chainId: number,
  id: Hex,
  p: Pick<ProposalMessage, "options" | "snapshotBlock">,
  votes: readonly CountedVote[],
  ctx: ResultContext = {},
): CouncilResult {
  const latest = new Map<string, CountedVote>();
  for (const v of votes) {
    const key = v.voter.toLowerCase();
    const prev = latest.get(key);
    if (!prev || BigInt(v.nonce) > BigInt(prev.nonce)) latest.set(key, v);
  }
  const counted = [...latest.values()].sort((a, b) => a.voter.toLowerCase().localeCompare(b.voter.toLowerCase()));
  return {
    kind: "vestally-council-result",
    version: 2,
    chainId,
    verifyingContract: ctx.verifyingContract ? (ctx.verifyingContract.toLowerCase() as Address) : null,
    proposalId: id,
    proposal: ctx.proposal ?? null,
    snapshotBlock: p.snapshotBlock.toString(),
    token: ctx.token ? (ctx.token.toLowerCase() as Address) : null,
    excluded: [...new Set((ctx.excluded ?? []).map((a) => a.toLowerCase() as Address))].sort(),
    options: p.options,
    tally: tally(p.options.length, counted),
    votes: counted,
  };
}

/**
 * Canonical JSON: object keys sorted, no spaces, integers only (as in RFC 8785 for these values).
 * The same result gives the same text however it was stored, including Postgres jsonb, which
 * reorders keys.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("Canonical JSON here only holds whole numbers.");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  throw new Error(`Can't put a ${typeof v} in canonical JSON.`);
}

/** Hash of a result over its canonical JSON. */
export function resultHash(r: CouncilResult): Hex {
  return keccak256(stringToBytes(canonicalJson(r)));
}
