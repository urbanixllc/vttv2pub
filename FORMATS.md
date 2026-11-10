# Formats and test vectors

What VesTally's files contain, and a set of known answers, so you can write your own checker in
any language and confirm it agrees. The rules behind every formula are in [`rules/`](rules/); the
reasoning is in the white papers at https://vestallytoken.io/papers.

All hashes are written `0x` + 64 lowercase hex. `keccak256` is Ethereum's Keccak-256 (not NIST
SHA3). `abi.encode` is Solidity ABI encoding (each value padded to 32 bytes).

## Records and the daily anchor

- A record is `(kind, value)`: a small integer fixed forever, and 32 bytes. Kinds in use: 1 seal,
  2 Council proposal, 3 vote, 4 result, 7 draw, 8 certificate, 11 Ledger checkpoint, 12 witness
  change, 13 Member voice, 14 game, 15 beacon output, 16 randomness request, 17 beacon commitment,
  18 sealed beacon secret. 5 and 6 are reserved.
- `leaf = keccak256(keccak256(abi.encode(uint8 kind, bytes32 value)))`.
- The daily tree sorts and de-duplicates its leaves, hashes pairs in sorted order
  (`keccak256(min ‖ max)`), and promotes an odd node unchanged. Only the root, the leaf count and the
  manifest digest (`keccak256` of the sorted leaves joined) go on BNB Chain, in the `Anchored` event
  of RecordAnchor, sent by VesTally's relayer (addresses in the README).

## Proof file (`vestally-proof`)

Downloaded from a check page; checked by `verify-proof.mjs`.

| Field | Meaning |
|---|---|
| `leafKind`, `code` | The record: for a seal, `code` is the file's SHA-256 |
| `root`, `proof` | The daily tree's root and the Merkle path from the leaf |
| `chainId`, `contract`, `txHash`, `blockNumber`, `recordedAt` | Where the root was anchored; the time is the block's own |
| `ledger` (optional) | The Ledger receipt below |

## Ledger receipt

| Field | Meaning |
|---|---|
| `record` | `{ kind, value }` |
| `height`, `time`, `prevHash`, `recordsRoot`, `blockHash` | The block: `blockHash = keccak256(abi.encode(DOMAIN, height, prevHash, time, recordsRoot))` |
| `proof` | Merkle path from the record's leaf to `recordsRoot` (same tree rules) |
| `sequencerSig` | The sequencer's signature over `blockHash` |
| `cosigs` | Witness co-signatures, over a different digest so a sequencer signature can't pass as one |

## FairSelect receipt (`vestally-fairselect-receipt`)

Checked by `verify-receipt/verify-receipt.mjs`.

| Field | Meaning |
|---|---|
| `rules` | Method, population root and count, sample size, order, optional hashes of the column name, notes and source report |
| `nonce` | Public random value; `salt = keccak256(abi.encode(SELECT_DOMAIN, sha256(canonical JSON of rules), nonce))` |
| `value` | The lock: a beacon Fair draw over `entriesCode = population root` with that salt |
| `lockRecord` | The lock's proof file (leaf kind 7) |
| `randomness` | The BNB Chain block (lock's anchor block + 100), its hash, and the Ledger beacon |
| `selection` | The sample as 0-based positions |
| `disclosures` | Members the organizer chose to show: `{ index, member, salt, path }`, each walking to the population root |

Member leaf: `keccak256(abi.encode(MEMBER_DOMAIN, uint256 i, salt_i, sha256(normalized member)))`,
with `salt_i = keccak256(abi.encode(SALT_DOMAIN, secret, uint256 i))`. The secret stays with the
organizer, so undisclosed members can't be guessed.

## RecordProof receipt (`vestally-recordproof-receipt`)

| Field | Meaning |
|---|---|
| `setCode` | The code on the record (a kind-1 seal): the Merkle root of the set's salted file leaves |
| `files` | `{ index, name, size, sha256 }` for each file; names stay in the receipt only |
| `secret` | Full receipts: rebuilds every file's salt |
| `disclosures` | One-file receipts: that file's salt and path, without the secret |
| `record` | The set code's proof file, once anchored |

## Test vectors

Inputs: `rep(b)` means the byte `b` repeated 32 times.

- **Seals.** `seal_code = sha256("hello")`; `daily_root_abc` is the daily tree over seals of
  `sha256("a")`, `sha256("b")`, `sha256("c")`.
- **FairSelect.** Members `INV-1`, `INV-2`, `INV-3` in that order; secret `rep(11)`; rules
  `{ spec: "vestally-fairselect-rules-v1", method: "simple-random-without-replacement",
  populationRoot: fs_root, populationCount: 3, sampleSize: 2, order: "file", randomness:
  { ledgerBeacon: true, target: "bnb-block+100" } }`; nonce `rep(22)`; BNB block hash `rep(33)`;
  beacon value `rep(44)`.
- **RecordProof.** Files with contents `alpha` and `bravo`, in that order; secret `rep(55)`.
- **Beacon v2.** Height 9, block hash `rep(09)`, sealed secret `rep(77)`, one reveal from
  `0x00000000000000000000000000000000000000aa` at index 1 with value `rep(06)`.

| Name | Value |
|---|---|
| `seal_code` | `0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824` |
| `seal_leaf` | `0x0f990762cd83d1fa9fd6fa41630da958271fcab573299616bd7241776f26aad4` |
| `daily_root_abc` | `0x2d560f5e434a6022960eab9ef2b9642f1301ee0beaa07380f79d9ab8eb3f7cf3` |
| `fs_member_hash_0` | `0x2a4d58777251b8ae76402789e6c0690223beae05002ba57e6d8490c5d132ffdb` |
| `fs_salt_0` | `0xfe03bfeea6a2e7ab0b0581e5036ecf29587c56fc5f16b820cfc9da868fab3091` |
| `fs_leaf_0` | `0x93b6c9693bb18be6ce440f7788f1ddb7c50c4d925fe192947cd408c4961c8a27` |
| `fs_root` | `0x9784750a251a8c0f505a94125b01cd81e0b95f286b1524d36e10a6d082c8d66e` |
| `fs_rules_hash` | `0xa654b1e1ed25cc66009ae595a45fe93609f8a6a91ddbaa34def1f8b96a3a8864` |
| `fs_selection_salt` | `0x82184ed8f199fe67748b09aff82f8a0884661ed463d0f2a78415145b5ca25a4e` |
| `fs_lock_value` | `0x2396d978e8cf01b7325b62f33da75c5d65f2143b3f803f566b237595eba9fd72` |
| `fs_randomness` | `0xc502f868a3f2d78c5adf18b41f606fc4c6cd8a4a9838125f03aadf235245b910` |
| `fs_sample_positions` | `2,1` |
| `rp_set_code` | `0xdb912eda7d14db15f47c4beced069c51c3dc4585555183fc6bd1deccc09a4bed` |
| `beacon_v2` | `0xd94a46f1022963e9a197e0df0ab89b6c2d459dfcc9c7d8bc982f3083b3683749` |

These are checked against VesTally's own library on every change, so they stay correct.
