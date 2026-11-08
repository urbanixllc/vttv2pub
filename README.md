# VesTally open tools

Small, independent programs for checking [VesTally](https://vestallytoken.io) without trusting
VesTally. Each one re-implements the rules on its own, so if it agrees with the site, that agreement
means something.

| Tool | What it does |
|---|---|
| [`verify-proof.mjs`](verify-proof.mjs) | Checks a VesTally proof file against your copy of the file and against BNB Chain, with no VesTally servers. One file, no dependencies. |
| [`witness/`](witness/) | Runs a VesTally Blockchain Ledger witness on your own computer: keeps a full copy, checks every block, co-signs it. |
| [`contracts/RecordAnchor.sol`](contracts/RecordAnchor.sol) | The contract the daily records are published to on BNB Chain. No owner, no storage, no funds. |

## Check a seal without VesTally

You need Node.js 18 or later.

```bash
node verify-proof.mjs vestally-proof-2b5e812d.json lease.pdf --rpc https://bsc-rpc.publicnode.com
```

Get the proof file from the seal's check page once the seal is recorded ("Batch details", then
"Download the proof file"). Use any BNB Chain RPC you like. A pass means this exact file existed by
the time of the block it was recorded in. It says nothing about who made the file or whether its
content is true.

## Run a witness

See [witness/README.md](witness/README.md).

## Addresses on BNB Chain (chain 56)

- RecordAnchor: `0x89D8EB0A3A5144E1dbE269CDee6dD3BBad8EF3C0`
- VesTally relayer (submits the daily records): `0xCDD05bB4eC7dfE5f981a0A89a80cA505452C5408`
- Ledger sequencer (signs Ledger blocks): `0x762613AE6F8dcFf2d2e35e0d39B56d42dfDfAEdf`

## Reporting a problem

If a tool disagrees with the site, or you find a security issue, open an issue here. For a
security issue, describe it without exploit details and we'll reply with a private channel.

This repository is published from VesTally's main (private) repository; changes made here directly
may be overwritten. MIT licensed.
