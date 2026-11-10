# verify-receipt

Checks VesTally for Business receipts on your own computer, with no VesTally servers: a
**FairSelect** selection receipt (`.fairselect.json`) or a **RecordProof** receipt
(`.recordproof.json`) and the files it covers. It reads BNB Chain through any public node you choose.

You need Node.js 18 or later.

```bash
cd verify-receipt
npm install
node verify-receipt.mjs selection.fairselect.json --rpc https://bsc-rpc.publicnode.com
node verify-receipt.mjs site-inspection.recordproof.json ./inspection-folder --rpc https://bsc-rpc.publicnode.com
```

## What it checks

**FairSelect**
1. The rules in the receipt are the ones in the lock (method, population size, sample size, notes).
2. The lock is recorded on BNB Chain by VesTally's relayer.
3. The random block is the lock's block + 100, read from the chain.
4. The Ledger witnesses' random number recomputes from its reveals and sealed secret.
5. The sample is exactly what the rules produce.
6. Each disclosed member sits at its locked position in the population.

**RecordProof**
1. The receipt's files make up its set code.
2. Each file you give it matches a file in the receipt (changed, extra and missing files are named).
3. The set code is recorded on BNB Chain by VesTally's relayer.

Lines marked `!` are warnings (for example, a record not yet anchored, or no witness contributed).

## What a pass means

- **RecordProof:** the files are unchanged since they were fingerprinted, and existed by the time
  on BNB Chain. It doesn't show who made them, that they're true, or that they're legally valid.
- **FairSelect:** the selection followed rules locked before the random number existed. The
  population itself is the organizer's own statement.

The formulas are in [`../rules/fairselect.ts`](../rules/fairselect.ts). Test vectors you can use to
check your own implementation are in [`../FORMATS.md`](../FORMATS.md); `node vectors.mjs` prints
them from this program's formulas.
