import { sha256, stringToBytes, type Hex } from "viem";

/**
 * Anchor my code: the seal code for a Git commit ID. Prefixed so a commit can never be mistaken for a
 * file whose SHA-256 happens to be the same 64 characters. Works for SHA-1 (40) and SHA-256 (64) IDs.
 */
export function commitCode(commitId: string): Hex {
  const id = commitId.trim().toLowerCase();
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) throw new Error("A commit ID is 40 or 64 hexadecimal characters.");
  return sha256(stringToBytes(`git-commit:${id}`));
}
