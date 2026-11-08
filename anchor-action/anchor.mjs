// VesTally Anchor my code. No dependencies: runs on the Node that GitHub runners already have.
//
// 1. Asks GitHub for a short-lived identity token proving which repository and commit this run is
//    for (needs `permissions: id-token: write`). That's the whole "sign-up": no API key.
// 2. Works out SHA-256 codes for the chosen files (and the release's assets) on the runner.
// 3. Sends only the commit ID and the codes. Files never leave the runner.
// 4. Writes check links to the job summary.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env;
const api = (env.INPUT_API_URL || "https://vestallytoken.io/api").replace(/\/$/, "");
const site = (env.INPUT_SITE_URL || "https://vestallytoken.io").replace(/\/$/, "");
const fail = (msg) => {
  console.log(`::error title=VesTally Anchor my code::${msg}`);
  process.exit(1);
};

async function identityToken() {
  if (env.VESTALLY_OIDC_TOKEN) return env.VESTALLY_OIDC_TOKEN; // local testing only
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    fail("No GitHub identity token. Add `permissions: id-token: write` to the job.");
  const res = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=vestally`, {
    headers: { Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!res.ok) fail(`GitHub refused an identity token (HTTP ${res.status}).`);
  return (await res.json()).value;
}

const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });

function releaseAssets() {
  if (env.INPUT_RELEASE_ASSETS === "false" || env.GITHUB_EVENT_NAME !== "release" || !env.GITHUB_REF_NAME) return [];
  const dir = mkdtempSync(join(tmpdir(), "vestally-"));
  try {
    execFileSync("gh", ["release", "download", env.GITHUB_REF_NAME, "--dir", dir, "--repo", env.GITHUB_REPOSITORY], { stdio: "inherit" });
  } catch {
    console.log("::warning::Couldn't download the release assets; sealing the commit and listed files only.");
    return [];
  }
  return readdirSync(dir).map((f) => join(dir, f));
}

const commit = (env.GITHUB_SHA || "").toLowerCase();
if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) fail("GITHUB_SHA isn't set.");

// Minimal glob (works on Node 20): ** = any folders, * = any name part, ? = one character.
function glob(pattern) {
  const toSlash = (s) => s.split("\\").join("/");
  const norm = toSlash(pattern).replace(/^\.\//, "");
  if (!/[*?]/.test(norm)) return existsSync(norm) ? [norm] : [];
  const escape = (part) =>
    part
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
  const re = new RegExp(`^${norm.split("**/").map(escape).join("(?:.*/)?")}$`);
  const all = readdirSync(".", { recursive: true }).map((f) => toSlash(String(f)));
  return all.filter((f) => !f.startsWith(".git/") && !f.startsWith("node_modules/") && re.test(f));
}

const patterns = (env.INPUT_FILES || "").split("\n").map((s) => s.trim()).filter(Boolean);
const paths = [...new Set([...patterns.flatMap((p) => glob(p)), ...releaseAssets()])].filter((p) => statSync(p).isFile());
if (paths.length > 100) fail("Up to 100 files per run.");
const files = [];
for (const p of paths) files.push({ name: p.split(/[\\/]/).pop(), code: await sha256File(p) });

const token = await identityToken();
const res = await fetch(`${api}/code/anchor`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ commit, codes: files.map((f) => f.code) }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) fail(body.error || `VesTally answered HTTP ${res.status}.`);

const commitCheck = `${site}/code?commit=${commit}`;
const lines = [
  "### VesTally: release sent to the public record",
  "",
  `Commit \`${commit.slice(0, 12)}\` and ${files.length} file${files.length === 1 ? "" : "s"} join the next daily record on BNB Chain.`,
  "",
  `- [Check this commit](${commitCheck})`,
  ...files.map((f) => `- \`${f.name}\`: [check](${site}/check/${f.code}) \`${f.code.slice(0, 16)}…\``),
  "",
  "Only codes were sent. Anyone can drop a downloaded file into the check page to confirm it's the released one.",
];
console.log(lines.join("\n"));
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `commit-code=${body.commitCode}\ncheck-url=${commitCheck}\n`);
