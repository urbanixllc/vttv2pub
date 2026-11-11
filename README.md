# VesTally open tools

Small, independent programs for checking [VesTally](https://vestallytoken.io) without trusting
VesTally. Each one re-implements the rules on its own, so if it agrees with the site, that agreement
means something.

| Tool | What it does |
|---|---|
| [`verify-proof.mjs`](verify-proof.mjs) | Checks a VesTally proof file against your copy of the file and against BNB Chain, with no VesTally servers. One file, no dependencies. |
| [`verify-receipt/`](verify-receipt/) | Checks VesTally for Business receipts: a FairSelect selection, or a RecordProof set and its files. |
| [`witness/`](witness/) | Runs a VesTally Blockchain Ledger witness on your own computer: keeps a full copy, checks every block, co-signs it. |
| [`anchor-action/`](anchor-action/) | Anchor my code: a GitHub Action that puts each release (its commit and files) on the public record. Use `urbanixllc/vttv2pub/anchor-action@v1`. |
| [`contracts/RecordAnchor.sol`](contracts/RecordAnchor.sol) | The contract the daily records are published to on BNB Chain. No owner, no storage, no funds. |
| [`rules/`](rules/) | Read-only reference copies of the code that decides results: records, the Ledger, randomness, games, draws, picks, FairSelect, RecordProof, Council results, certificates and code anchoring. |
| [`FORMATS.md`](FORMATS.md) | What proof files and receipts contain, and test vectors to check your own implementation against. |

## Check a seal without VesTally

You need Node.js 18 or later.

```bash
node verify-proof.mjs vestally-proof-2b5e812d.json lease.pdf --rpc https://bsc-rpc.publicnode.com
```

Get the proof file from the seal's check page once the seal is recorded ("Batch details", then
"Download the proof file"). Use any BNB Chain RPC you like. A pass means this exact file existed by
the time of the block it was recorded in. It says nothing about who made the file or whether its
content is true.

The record contract is open to anyone, so the verifier also checks the root was published by
VesTally's relayer (built in for BNB Chain). A root someone anchored themselves fails. On a test
chain, name the relayer with `--submitter <address>`.

## Read records from your own systems

The read-only Trust API serves the same records, receipts, random numbers and anchors these tools
check: `https://vestallytoken.io/api/v1` (no key needed; description at
`https://vestallytoken.io/api/v1/openapi.json`). Don't trust its answers: check them with the tools
here.

## Check a business receipt

See [verify-receipt/README.md](verify-receipt/README.md).

## Run a witness

See [witness/README.md](witness/README.md). Anyone can run one to keep a full copy and check every
block and anchor; co-signing and adding randomness need approval (the white paper on the Ledger
explains why).

## Read the white papers

The design and security analysis behind all of this: https://vestallytoken.io/papers

- *The VesTally Blockchain Ledger* (P1)
- *Fingerprints, Not Files* (P2)
- *A Witness Randomness Beacon from Hash-Chain Commitments* (P3)
- *Composing Fairness* (P4)

## Addresses on BNB Chain (chain 56)

- RecordAnchor: `0x89D8EB0A3A5144E1dbE269CDee6dD3BBad8EF3C0`
- VesTally relayer (submits the daily records): `0xCDD05bB4eC7dfE5f981a0A89a80cA505452C5408`
- Ledger sequencer (signs Ledger blocks): `0x762613AE6F8dcFf2d2e35e0d39B56d42dfDfAEdf`

## What isn't here, and why

This repository holds what you need to **check** VesTally: the checkers, the witness, the contract,
the GitHub Action, the rules and the formats. The service itself (the website and its tools, the
API, the Ledger sequencer, accounts and the admin panel, the charity games service, the Discord bot
and the Learning Lab content) stays in VesTally's private repository. You don't need any of it to
verify a result.

## Reporting a problem

If a tool disagrees with the site, or you find a security issue, open an issue here. For a
security issue, describe it without exploit details and we'll reply with a private channel.

This repository is published from VesTally's main (private) repository; changes made here directly
may be overwritten. MIT licensed.
