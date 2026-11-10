# Run a VesTally Blockchain Ledger witness

A witness keeps its own full copy of the Ledger, checks every new block, and co-signs it. If
VesTally ever served a rewritten history, your witness would refuse to sign and stop with an alert.
Witnesses also add the randomness behind fair games such as charity bingo (see
[Random numbers](#random-numbers)).

About every ten minutes it also reads VesTally's latest anchor transactions straight from BNB
Chain, through a public node and not through VesTally, and checks that the anchored checkpoint is a
block in its own copy. If VesTally ever showed your witness one history and anchored another, it
says so. To use a different BNB Chain node add `--bnb-rpc <url>` (or `WITNESS_BNB_RPC`); to switch
the check off, `--anchor-check off`.

Every random-number contribution VesTally accepts comes back with a signed receipt, kept in
`witness-data/receipts.jsonl`. If one were ever left out, your witness prints an alert with the
receipt, which proves it to anyone.

It's a small program: about 40 MB of memory and almost no CPU. If your computer is off, it catches
up when it's back; the Ledger never waits for you.

You need two things:

- **A name to show publicly** (2 to 60 characters), such as your Discord name.
- **The Ledger's signing address:** `0x762613AE6F8dcFf2d2e35e0d39B56d42dfDfAEdf`. Check it matches
  the one on [vestallytoken.io/ledger](https://vestallytoken.io/ledger). Your witness refuses
  blocks signed by anyone else.

Pick one way to run it:

- [Docker](#docker-easiest-if-you-have-it): easiest if you already have Docker (Windows, Mac or Linux)
- [Windows](#windows)
- [Linux](#linux) (also works on a Mac with small changes)

The first time it runs, it makes your **witness key** (`witness-key.json`) and asks to join the
witness list. The request is signed with that key and carries only your witness address and name.
Once an admin approves it, your witness co-signs everything it has checked and keeps going.

> **Your key is your witness identity.** It never leaves your computer. Never send it to anyone,
> and keep a backup somewhere safe. If you lose it, you'd have to join again as a new witness.

---

## Docker (easiest if you have it)

You need [Docker](https://docs.docker.com/get-docker/) and git.

**Set up**

```bash
git clone https://github.com/urbanixllc/vttv2pub.git
cd vttv2pub/witness
echo "WITNESS_LABEL=Your name" > .env
docker compose up -d
```

That's it. It starts with Docker, restarts itself if it stops, and keeps your key and data in a
Docker volume.

**Check it:** `docker compose logs -f` (press Ctrl+C to stop watching). The first lines show your
witness address and say the witness has asked to join.

**Back up your key** (do this once):

```bash
docker compose cp witness:/data/witness-key.json ./witness-key-backup.json
```

Move that backup file somewhere safe, such as a USB stick or a password manager, and delete it here.

**Update**

```bash
cd vttv2pub/witness
git pull
docker compose up -d --build
```

**Stop:** `docker compose down`. Your key and data stay in the volume. Start again with
`docker compose up -d`.

---

## Windows

**1. Install Node.js.** Get the LTS version from [nodejs.org](https://nodejs.org) and install it
with the default options.

**2. Get the witness program.** Open **PowerShell** (Start menu → type "PowerShell") and run:

```powershell
mkdir $HOME\vestally-witness; cd $HOME\vestally-witness
foreach ($f in "witness.mjs","package.json","package-lock.json") { Invoke-WebRequest "https://vestallytoken.io/witness/$f" -OutFile $f }
npm install
```

**3. Try it.** Put your name in place of `Your name`:

```powershell
node witness.mjs run --sequencer 0x762613AE6F8dcFf2d2e35e0d39B56d42dfDfAEdf --label "Your name"
```

It prints your witness address and says it has asked to join. Press **Ctrl+C** to stop it. Now
**back up `witness-key.json`** from that folder.

**4. Keep it running in the background.** Closing the PowerShell window stops the witness. To have
it start with Windows, with no window, whether or not anyone is signed in, open **PowerShell as
administrator** (right-click PowerShell → "Run as administrator") and run this, again with your name:

```powershell
cd $HOME\vestally-witness
$a = New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c node witness.mjs run --sequencer 0x762613AE6F8dcFf2d2e35e0d39B56d42dfDfAEdf --label "Your name" >> witness.log 2>&1' -WorkingDirectory (Get-Location).Path
$t = New-ScheduledTaskTrigger -AtStartup
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask VesTallyWitness -Action $a -Trigger $t -Principal $p -Settings $s
Start-ScheduledTask VesTallyWitness
```

**Check it:** open `witness.log` in that folder; new lines appear as blocks are co-signed. Or run
`Get-Content $HOME\vestally-witness\witness.log -Tail 20 -Wait`.

The witness only works while the computer is awake. If Windows sleeps, the witness catches up when it
wakes.

**Update** (in PowerShell as administrator):

```powershell
cd $HOME\vestally-witness
Stop-ScheduledTask VesTallyWitness
foreach ($f in "witness.mjs","package.json","package-lock.json") { Invoke-WebRequest "https://vestallytoken.io/witness/$f" -OutFile $f }
npm install
Start-ScheduledTask VesTallyWitness
```

**Stop for good:** `Unregister-ScheduledTask VesTallyWitness -Confirm:$false`. Your key and data
stay in the folder.

---

## Linux

**1. Install Node.js 18 or later.** On Debian or Ubuntu: `sudo apt install nodejs npm`. If your
distribution's Node.js is older than 18, use the instructions at [nodejs.org](https://nodejs.org).
Check with `node --version`.

**2. Get the witness program.**

```bash
mkdir -p ~/vestally-witness && cd ~/vestally-witness
for f in witness.mjs package.json package-lock.json; do curl -fsSLO "https://vestallytoken.io/witness/$f"; done
npm install
```

**3. Try it.** Put your name in place of `Your name`:

```bash
node witness.mjs run --sequencer 0x762613AE6F8dcFf2d2e35e0d39B56d42dfDfAEdf --label "Your name"
```

It prints your witness address and says it has asked to join. Press **Ctrl+C** to stop it. Now
**back up `witness-key.json`** from that folder.

**4. Keep it running in the background** with systemd, starting at boot even when you're not logged
in. Use your name in the `ExecStart` line:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/vestally-witness.service <<EOF
[Unit]
Description=VesTally Ledger witness
After=network-online.target

[Service]
WorkingDirectory=%h/vestally-witness
ExecStart=$(command -v node) witness.mjs run --sequencer 0x762613AE6F8dcFf2d2e35e0d39B56d42dfDfAEdf --label "Your name"
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now vestally-witness
sudo loginctl enable-linger "$USER"
```

**Check it:** `journalctl --user -u vestally-witness -f` (Ctrl+C to stop watching), or
`systemctl --user status vestally-witness`.

**Update**

```bash
cd ~/vestally-witness
for f in witness.mjs package.json package-lock.json; do curl -fsSLO "https://vestallytoken.io/witness/$f"; done
npm install
systemctl --user restart vestally-witness
```

**Stop for good:** `systemctl --user disable --now vestally-witness`. Your key and data stay in the
folder.

---

## Which version am I running?

The first line the witness prints, and its log after every restart, shows its version, such as
`VesTally witness 2026.11.11`. Or run `node witness.mjs version`. The newest version is the one in
this repository. Updating keeps your key, your copy of the Ledger and your randomness chain.

## Random numbers

Your witness also helps make random numbers nobody can predict, such as the balls in charity bingo
games. On first run it makes a secret chain of values in `witness-data/beacon.json` and publishes
only a fingerprint of it. Whenever the Ledger asks for a random number, it adds the next value.
When more than five witnesses are ready, five are picked for each number; the others are told
they were skipped this time, which isn't an error.
Nobody else knows that value in advance, so nobody, VesTally included, can see the number coming.
There's nothing to set up. It costs a few bytes per request, and during a game the program checks
every second instead of every 3. If your contribution is ever left out, it prints an ALERT.
Deleting `beacon.json` is harmless: a new chain is made and published.

## What it does, and doesn't do

- **It does:** download each new block, check its records, its link to the block before it, and
  VesTally's signature, then co-sign it. It also adds randomness when asked.
- **It doesn't:** hold or move tokens, need a wallet, open any ports, or send anything but block
  co-signatures, randomness values and your join request.
- **Your data:** your copy of the Ledger is in `witness-data/`. It holds only fingerprints, never
  files or personal details.

This program is an independent implementation of the block rules: it doesn't reuse VesTally's own
code, so it checks VesTally rather than trusting it. Being a witness earns recognition and
standing, not tokens.
