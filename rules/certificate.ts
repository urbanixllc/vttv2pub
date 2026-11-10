import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";
import { canonicalJson } from "./council";

/**
 * Learning Lab certificates.
 *
 * The public certificate names nobody. In place of the holder it carries
 * holder = keccak256(abi.encode(salt, name)), where the salt is a random number that only the
 * holder's own copy contains. Without the salt, nobody can confirm a guessed name from the public
 * certificate; with it (the holder shares it in their copy or the QR link), anyone can confirm the
 * name printed on it. No wallet address is in the certificate either.
 *
 * The certificate's ID is keccak256 of its canonical JSON. VesTally signs that ID and puts it on the
 * public record.
 */

/** Names are compared after this clean-up, so spacing and Unicode form don't matter. */
export const normalizeHolderName = (name: string) => name.normalize("NFC").replace(/\s+/g, " ").trim();

export function certificateHolder(salt: Hex, name: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "string" }], [salt, normalizeHolderName(name)]));
}

export function certificateHash(body: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(body)));
}
