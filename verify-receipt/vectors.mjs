// Prints the test vectors in tools/public/FORMATS.md, computed with this verifier's own formulas.
// services/api/test/formats-vectors.test.ts recomputes every one with VesTally's library.
//   node tools/verify-receipt/vectors.mjs
import { createHash } from "node:crypto";
import { encodeAbiParameters, getAddress, keccak256 } from "viem";
import { recordLeaf } from "../verify-proof.mjs";
import * as t from "./verify-receipt.mjs";

const sha = (s) => "0x" + createHash("sha256").update(s, "utf8").digest("hex");
const rep = (b, n = 32) => "0x" + b.repeat(n);

export function vectors() {
  const v = {};
  // Seals and the daily tree
  v.seal_code = sha("hello");
  v.seal_leaf = recordLeaf(1, v.seal_code);
  const leaves = ["a", "b", "c"].map((s) => recordLeaf(1, sha(s))).sort();
  v.daily_root_abc = t.merkleRoot(leaves);
  // FairSelect
  const secret = rep("11");
  const members = ["INV-1", "INV-2", "INV-3"];
  v.fs_member_hash_0 = t.memberHash(members[0]);
  v.fs_salt_0 = t.itemSalt(t.DOMAINS.fairselect, secret, 0);
  v.fs_leaf_0 = t.itemLeaf(t.DOMAINS.fairselect, 0, v.fs_salt_0, v.fs_member_hash_0);
  v.fs_root = t.merkleRoot(members.map((m, i) => t.itemLeaf(t.DOMAINS.fairselect, i, t.itemSalt(t.DOMAINS.fairselect, secret, i), t.memberHash(m))));
  const rules = {
    spec: "vestally-fairselect-rules-v1",
    method: "simple-random-without-replacement",
    populationRoot: v.fs_root,
    populationCount: 3,
    sampleSize: 2,
    order: "file",
    randomness: { ledgerBeacon: true, target: "bnb-block+100" },
  };
  v.fs_rules_hash = t.rulesHash(rules);
  v.fs_selection_salt = t.selectionSalt(v.fs_rules_hash, rep("22"));
  v.fs_lock_value = t.drawValueBeacon({ entriesCode: v.fs_root, entryCount: 3, winnerCount: 2, salt: v.fs_selection_salt });
  v.fs_randomness = t.drawRandomness(rep("33"), rep("44"));
  v.fs_sample_positions = t.pickWinners(v.fs_lock_value, v.fs_randomness, 3, 2).join(",");
  // RecordProof
  const files = ["alpha", "bravo"].map(sha);
  v.rp_set_code = t.merkleRoot(files.map((h, i) => t.itemLeaf(t.DOMAINS.recordproof, i, t.itemSalt(t.DOMAINS.recordproof, rep("55"), i), h)));
  // Beacon v2
  const reveal = { witness: getAddress("0x00000000000000000000000000000000000000aa"), index: 1, value: rep("06"), prev: { index: 0, value: keccak256(rep("06")) } };
  v.beacon_v2 = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address[]" }, { type: "uint64[]" }, { type: "bytes32[]" }],
      [t.DOMAINS.beaconV2, 9n, rep("09"), rep("77"), [reveal.witness], [1n], [reveal.value]],
    ),
  );
  return v;
}

if (process.argv[1]?.endsWith("vectors.mjs")) for (const [k, x] of Object.entries(vectors())) console.log(`| \`${k}\` | \`${x}\` |`);
