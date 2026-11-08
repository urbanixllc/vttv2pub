# Run a VesTally Blockchain Ledger witness

A witness keeps its own full copy of the Ledger, checks every new block, and co-signs it. If
VesTally ever served a rewritten history, your witness would refuse and stop with an alert.

You need Node.js 18 or later. Nothing else is installed system-wide.

```bash
npm install
node witness.mjs init
```

`init` creates `witness-key.json` **on your computer** and prints your witness address. Never send
anyone the key file, and back it up: it is your witness identity.

Then start it, with a name to show publicly:

```bash
node witness.mjs run --site https://vestallytoken.io --sequencer <address from the site's Ledger page> --label "Your name"
```

The first run asks to join the witness list for you. The request is signed with your witness key and
carries only your witness address and the label. While you wait for approval, the program keeps its
copy up to date; once approved, it co-signs everything it holds and keeps going.

Leave it running. If you turn your computer off, it catches up when you come back. Your copy of the
Ledger is kept in `witness-data/`.

This program is an independent implementation of the block rules: it doesn't reuse VesTally's own
code, so it checks VesTally rather than trusting it. Being a witness earns recognition and
standing, not tokens.
