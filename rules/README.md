# The rules, as code

Reference copies of the code that decides VesTally results, so anyone can read exactly how they're
made and checked. They're copied from VesTally's own source on each publish.

| File | What it decides |
|---|---|
| `beacon.ts` | The Ledger randomness beacon: witness commitments, reveals, how the random number is mixed, and the checks |
| `games.ts` | Charity games: bingo cards and balls, raffle prizes and prize-wheel spins |
| `draw.ts` | Fair draws: the lock, and winners from a BNB Chain block plus the beacon |
| `pick.ts` | Fair picks (the Discord `/fairpick` command) |
| `ledger.ts` | Ledger blocks, receipts and co-signatures |
| `seal.ts` | Record fingerprints and the Merkle tree used for the daily BNB Chain anchor |

They use [viem](https://viem.sh) for hashing and encoding. The plain-English explanation, with the
assumptions behind each security claim, is at https://vestallytoken.io/ledger/randomness.

The witness program in `../witness` is a separate, independent implementation of the block and
randomness rules: it checks VesTally rather than reusing this code.
