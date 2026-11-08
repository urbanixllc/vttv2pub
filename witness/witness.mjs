#!/usr/bin/env node
/**
 * VesTally Blockchain Ledger: community witness. Runs on your own computer.
 *
 * A witness keeps its own full copy of the Ledger, checks that every new block only adds to the last
 * one (right height, linked to the previous block, records matching the root, signed by VesTally's
 * sequencer), and co-signs it. If VesTally ever served a rewritten history, this witness refuses to
 * sign and stops with an alert. That's the point of having witnesses outside VesTally.
 *
 *   npm install                      (once: installs viem, the only dependency)
 *   node witness.mjs init            makes your witness key on this computer and prints its address
 *   node witness.mjs run --site https://vestallytoken.io --sequencer 0x... --label "Your name"
 *
 * The first run asks to join: it sends the site a request signed with your witness key (address and
 * label only). An admin approves it in the admin panel; until then the program keeps its copy up to
 * date, and once approved it co-signs everything it holds. Your key never leaves this computer.
 * This is an independent implementation of the block rules (it doesn't use VesTally's own code),
 * which is a check in itself.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { concat, encodeAbiParameters, getAddress, keccak256, recoverMessageAddress, stringToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const KEY_FILE = "witness-key.json";
const DATA = "witness-data";
const GENESIS_PREV = `0x${"00".repeat(32)}`;
const EMPTY_ROOT = `0x${"00".repeat(32)}`;

// ---------- the block rules (docs/vtt-ledger-design.md) ----------
const BLOCK_DOMAIN = keccak256(stringToBytes("VesTally Blockchain Ledger block v1"));
const COSIGN_DOMAIN = stringToBytes("VesTally Blockchain Ledger cosign v1");

/** leaf = keccak256(keccak256(abi.encode(uint8 kind, bytes32 value))) */
export const leafOf = (r) => keccak256(keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [r.kind, r.value.toLowerCase()])));
const pair = (a, b) => (a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/** Merkle root: leaves sorted and de-duplicated; pairs hashed in sorted order; an odd node moves up unchanged. */
export function recordsRoot(records) {
  if (!records.length) return EMPTY_ROOT;
  let level = [...new Set(records.map((r) => leafOf(r).toLowerCase()))].sort();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(level[i + 1] ? pair(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

export const blockHash = (b) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }],
      [BLOCK_DOMAIN, BigInt(b.height), b.prevHash, BigInt(b.time), b.recordsRoot],
    ),
  );
export const cosignDigest = (hash) => keccak256(concat([COSIGN_DOMAIN, hash]));

export async function checkBlock(b, prev, sequencer) {
  if (!prev) {
    if (b.height !== 0 || b.prevHash !== GENESIS_PREV) return "the first block must be height 0";
  } else {
    if (b.height !== prev.height + 1) return `expected height ${prev.height + 1}, got ${b.height}`;
    if (b.prevHash.toLowerCase() !== prev.hash.toLowerCase()) return `block ${b.height} doesn't link to block ${prev.height}`;
    if (b.time < prev.time) return `block ${b.height} goes back in time`;
  }
  if (recordsRoot(b.records).toLowerCase() !== b.recordsRoot.toLowerCase()) return `block ${b.height}'s records don't match its root`;
  if (blockHash(b).toLowerCase() !== b.hash.toLowerCase()) return `block ${b.height}'s hash is wrong`;
  const who = await recoverMessageAddress({ message: { raw: b.hash }, signature: b.sequencerSig }).catch(() => null);
  if (!who || who.toLowerCase() !== sequencer.toLowerCase()) return `block ${b.height} isn't signed by the sequencer`;
  return null;
}

// ---------- running ----------
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function api(site, path, init) {
  const res = await fetch(`${site.replace(/\/$/, "")}/api/ledger/${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

// ---------- joining: a request signed with the witness key ----------
/** Must match the site's requestMessage exactly. */
const requestMessage = (address, label, time) => `VesTally witness request\nAddress: ${getAddress(address)}\nLabel: ${label}\nTime: ${time}`;

async function requestStatus(site, address) {
  const res = await fetch(`${site.replace(/\/$/, "")}/api/witness-requests/${address}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`status: HTTP ${res.status}`);
  return (await res.json()).status;
}

async function sendRequest(site, account, label) {
  const time = Date.now();
  const signature = await account.signMessage({ message: requestMessage(account.address, label, time) });
  const res = await fetch(`${site.replace(/\/$/, "")}/api/witness-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address, label, time, signature }),
    signal: AbortSignal.timeout(15_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out.status;
}

async function run() {
  const site = arg("site");
  const sequencer = arg("sequencer");
  const label = arg("label");
  if (!site || !/^0x[0-9a-fA-F]{40}$/.test(sequencer ?? "")) {
    console.log('Usage: node witness.mjs run --site <https://…> --sequencer <0x… address shown on the Ledger page> --label "Your name"');
    process.exit(2);
  }
  if (!existsSync(KEY_FILE)) {
    console.log("No witness key yet. Run: node witness.mjs init");
    process.exit(2);
  }
  const account = privateKeyToAccount(JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey);
  mkdirSync(DATA, { recursive: true });
  const file = join(DATA, "blocks.jsonl");
  const blocks = [];
  if (existsSync(file)) {
    // A crash or full disk can leave the last line half written: drop just that line and carry on.
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n");
    let good = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) { good += lines[i].length + 1; continue; }
      try {
        blocks.push(JSON.parse(lines[i]));
        good += lines[i].length + 1;
      } catch {
        if (lines.slice(i + 1).some((l) => l.trim())) throw new Error(`${file}: line ${i + 1} is damaged. Delete the file to download a fresh copy.`);
        console.warn("Dropped an unfinished last line in blocks.jsonl (left by a crash or full disk).");
        writeFileSync(file, raw.slice(0, Math.min(good, raw.length)));
        break;
      }
    }
  }
  console.log(`Witness ${account.address}. Holding ${blocks.length} block(s). Watching ${site}.`);

  // Are we on the witness list? If not, ask to join (once), then keep checking.
  let approved = false;
  let lastCheck = 0;
  const checkApproval = async () => {
    lastCheck = Date.now();
    const status = await requestStatus(site, account.address);
    if (status === "approved") {
      if (!approved) console.log("You're on the witness list. Co-signing.");
      approved = true;
      return;
    }
    approved = false;
    if (status === "pending") return;
    if (!label || label.trim().length < 2) {
      console.log('Not a witness yet. Add --label "Your name" (2 to 60 characters, shown publicly) to ask to join.');
      return;
    }
    const s = await sendRequest(site, account, label.trim());
    console.log(s === "approved" ? "You're on the witness list. Co-signing." : "Asked to join the witness list. Waiting for approval; your copy keeps up meanwhile.");
    approved = s === "approved";
  };
  await checkApproval().catch((e) => console.warn(`Couldn't check the witness list (${e.message}); will retry.`));
  // How far our copy is co-signed. When approval comes, everything already checked gets co-signed.
  let backlog = approved ? blocks.length : 0;

  for (;;) {
    try {
      const head = await api(site, "head");
      const mine = blocks.at(-1);
      if (mine) {
        const [theirs] = await api(site, `blocks?from=${mine.height}&limit=1`);
        if (!theirs || theirs.hash.toLowerCase() !== mine.hash.toLowerCase()) {
          console.error(`ALERT: the site's block ${mine.height} differs from the copy you co-signed. History was rewritten. Stopping; keep ${file} as evidence.`);
          process.exit(1);
        }
      }
      if (!approved && Date.now() - lastCheck > 60_000) await checkApproval();
      // Just approved: vouch for the copy we already checked.
      if (approved && backlog < blocks.length) {
        const n = blocks.length - backlog;
        for (; backlog < blocks.length; backlog++) {
          const b = blocks[backlog];
          const signature = await account.signMessage({ message: { raw: cosignDigest(b.hash) } });
          await api(site, "cosigs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ height: b.height, witness: account.address, signature }) }).catch(() => {});
        }
        console.log(`Co-signed the ${n} block(s) already in your copy.`);
      }
      let next = mine ? mine.height + 1 : 0;
      let signed = 0;
      let checked = 0;
      while (head && next <= head.height) {
        const batch = await api(site, `blocks?from=${next}&limit=200`);
        if (!batch.length) break;
        for (const b of batch) {
          const problem = await checkBlock(b, blocks.at(-1), sequencer);
          if (problem) {
            console.error(`ALERT: refused ${problem}. Stopping.`);
            process.exit(1);
          }
          appendFileSync(file, JSON.stringify(b) + "\n");
          blocks.push(b);
          checked++;
          if (approved) {
            const signature = await account.signMessage({ message: { raw: cosignDigest(b.hash) } });
            await api(site, "cosigs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ height: b.height, witness: account.address, signature }) }).catch((e) => {
              console.warn(`  co-signature for block ${b.height} not accepted (${e.message}).`);
              if (/403/.test(e.message)) lastCheck = 0; // maybe removed from the list: check again
            });
            signed++;
            backlog = blocks.length;
          }
          next = b.height + 1;
        }
      }
      if (signed) console.log(`${new Date().toISOString()}  checked and co-signed ${signed} block(s); now at #${blocks.at(-1).height}`);
      else if (checked) console.log(`${new Date().toISOString()}  checked ${checked} block(s); now at #${blocks.at(-1).height} (waiting for approval to co-sign)`);
    } catch (e) {
      console.warn(`${new Date().toISOString()}  ${e.message}; retrying`);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

function init() {
  if (existsSync(KEY_FILE)) {
    const a = privateKeyToAccount(JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey);
    console.log(`You already have a witness key. Address: ${a.address}`);
    return;
  }
  const privateKey = generatePrivateKey();
  writeFileSync(KEY_FILE, JSON.stringify({ privateKey, note: "VesTally witness key. Keep it on this computer. Never send it to anyone." }, null, 2), { mode: 0o600 });
  console.log(`Witness key created in ${KEY_FILE} (keep it private and backed up).`);
  console.log(`Your witness address: ${privateKeyToAccount(privateKey).address}`);
  console.log('Next: node witness.mjs run --site <site> --sequencer <address> --label "Your name". It asks to join for you.');
}

const cmd = process.argv[2];
if (process.argv[1]?.replace(/\\/g, "/").endsWith("witness.mjs")) {
  if (cmd === "init") init();
  else if (cmd === "run") await run();
  else console.log('Commands: init | run --site <url> --sequencer <address> --label "Your name"');
}
