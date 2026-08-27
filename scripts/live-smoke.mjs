#!/usr/bin/env node
/**
 * Live integration smoke test for the background capture-to-cloud-solve path.
 *
 * Loads .development.env locally, then checks:
 * - Supabase REST reachability
 * - screenshot Storage upload/sign/download/delete
 * - Telegram bot getMe + dev message
 * - APNs private key signing from APNS_PRIVATE_KEY or APNS_PRIVATE_KEY_PATH
 * - optional queued solve job + one worker tick
 *
 * Secrets are never printed.
 */

import { createHash, createSign, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".development.env");
const BUCKET = "screenshots";
const APP = "Code Editor";
const args = new Set(process.argv.slice(2));
const SHOULD_SOLVE = !args.has("--no-solve");
const SHOULD_NOTIFY_TELEGRAM = !args.has("--no-telegram");

const startedAll = Date.now();
let failures = 0;

function green(s) {
  return `\x1b[32m${s}\x1b[0m`;
}

function red(s) {
  return `\x1b[31m${s}\x1b[0m`;
}

function yellow(s) {
  return `\x1b[33m${s}\x1b[0m`;
}

function dim(s) {
  return `\x1b[2m${s}\x1b[0m`;
}

function ok(label, passed, detail = "") {
  console.log(`  ${passed ? green("ok  ") : red("FAIL")} ${label}${detail ? ` ${dim(detail)}` : ""}`);
  if (!passed) failures++;
  return passed;
}

function warn(label, detail = "") {
  console.log(`  ${yellow("skip")} ${label}${detail ? ` ${dim(detail)}` : ""}`);
}

function section(name) {
  console.log(`\n${name}`);
}

function loadDotEnv(file) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
  return true;
}

function mustEnv(name) {
  return process.env[name]?.trim() || "";
}

function serviceKey() {
  return (
    mustEnv("SUPABASE_SERVICE_ROLE_KEY") ||
    mustEnv("SUPABASE_SERVICE_KEY") ||
    mustEnv("SUPABASE_SERVICE_KEY")
  );
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function apnsPrivateKey() {
  const inline = process.env.APNS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (inline?.trim()) return inline;

  const privateKeyPath = process.env.APNS_PRIVATE_KEY_PATH?.trim();
  if (!privateKeyPath) return "";
  return readFileSync(path.resolve(ROOT, privateKeyPath), "utf8");
}

function signApnsToken() {
  const keyId = mustEnv("APNS_KEY_ID");
  const teamId = mustEnv("APNS_TEAM_ID");
  const privateKey = apnsPrivateKey();
  if (!keyId || !teamId || !privateKey) return "";
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
  const signer = createSign("sha256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${b64url(signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }))}`;
}

async function rest(pathname, init = {}) {
  const base = mustEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = serviceKey();
  const res = await fetch(`${base}/rest/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function storage(pathname, init = {}) {
  const base = mustEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = serviceKey();
  const res = await fetch(`${base}/storage/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function timed(label, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    ok(label, true, `${Date.now() - started}ms`);
    return value;
  } catch (err) {
    ok(label, false, `${Date.now() - started}ms ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function ensureBucket() {
  const base = mustEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = serviceKey();
  const res = await fetch(`${base}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 409 && !text.includes("already exists")) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
}

async function uploadFixture(prefix) {
  const fixturePath = path.join(ROOT, "scripts", "vision-fixture.png");
  const bytes = await fs.readFile(fixturePath);
  const objectPath = `${prefix}/${randomUUID()}.png`;
  const base = mustEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = serviceKey();
  const put = await fetch(`${base}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "image/png",
      "x-upsert": "true",
    },
    body: bytes,
  });
  const putText = await put.text();
  if (!put.ok) throw new Error(`${put.status} ${put.statusText}: ${putText.slice(0, 400)}`);
  return { objectPath, bytes };
}

async function signedUrl(objectPath) {
  const signed = await storage(`object/sign/${BUCKET}/${objectPath}`, {
    method: "POST",
    body: JSON.stringify({ expiresIn: 300 }),
  });
  const value = signed?.signedURL || signed?.signedUrl;
  if (!value) throw new Error("Supabase returned no signed URL.");
  return value.startsWith("http")
    ? value
    : `${mustEnv("SUPABASE_URL").replace(/\/$/, "")}/storage/v1${value}`;
}

async function deleteObject(objectPath) {
  const base = mustEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = serviceKey();
  await fetch(`${base}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "DELETE",
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
}

async function telegramCheck() {
  if (!SHOULD_NOTIFY_TELEGRAM) {
    warn("Telegram bot message", "--no-telegram was passed");
    return;
  }
  const token = mustEnv("TELEGRAM_BOT_TOKEN");
  const chatId = mustEnv("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    warn("Telegram bot message", "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
    return;
  }
  const me = await timed("Telegram getMe", async () => {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.description || res.statusText);
    return json.result?.username || "bot";
  });
  if (!me) {
    console.log(dim("       Network timeout here means this machine cannot reach api.telegram.org yet."));
  }
  if (me) {
    await timed("Telegram dev alert", async () => {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `${APP} dev smoke test: external bot channel is reachable.`,
          disable_web_page_preview: true,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.description || res.statusText);
    });
  }
}

async function apnsCheck() {
  if (!mustEnv("APNS_KEY_ID") || !mustEnv("APNS_TEAM_ID") || !mustEnv("APNS_BUNDLE_ID")) {
    warn("APNs token signing", "APNS_KEY_ID, APNS_TEAM_ID or APNS_BUNDLE_ID is missing");
    return;
  }
  await timed("APNs token signing", async () => {
    const token = signApnsToken();
    if (token.split(".").length !== 3) throw new Error("APNs token was not generated.");
  });
  await timed("registered iOS devices query", async () => {
    await rest("notification_devices?platform=eq.ios&enabled=eq.true&select=id,platform&limit=5");
  });
}

async function storageRoundTrip() {
  let objectPath = "";
  try {
    await timed("Storage bucket ready", ensureBucket);
    const uploaded = await timed("Storage fixture upload", () => uploadFixture("selftest"));
    if (!uploaded) return;
    objectPath = uploaded.objectPath;
    const url = await timed("Storage signed URL", () => signedUrl(objectPath));
    if (!url) return;
    await timed("Storage signed download", async () => {
      const res = await fetch(url);
      const back = Buffer.from(await res.arrayBuffer());
      const got = createHash("sha256").update(back).digest("hex");
      const expected = createHash("sha256").update(uploaded.bytes).digest("hex");
      if (!res.ok || got !== expected) throw new Error(`download mismatch: HTTP ${res.status}`);
    });
  } finally {
    if (objectPath) await timed("Storage cleanup", () => deleteObject(objectPath));
  }
}

async function createSmokeJob() {
  await ensureBucket();
  const session = await rest("sessions", {
    method: "POST",
    body: JSON.stringify({ title: `Cloud smoke ${new Date().toISOString()}` }),
  });
  const sessionId = session?.[0]?.id;
  if (!sessionId) throw new Error("Session insert returned no id.");

  const uploaded = await uploadFixture(sessionId);
  const job = await rest("solve_jobs", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      mode: "council",
      status: "queued",
      progress_phase: "queued",
      settings_snapshot: {
        mode: "auto",
        maxTokens: 1200,
        executionProvider:
          mustEnv("CODE_AUDITOR_SMOKE_EXECUTION") ||
          (mustEnv("E2B_API_KEY") ? "e2b" : "local"),
        benchmarkBackend: "actions",
        githubRepository: mustEnv("GITHUB_REPOSITORY") || mustEnv("CODE_AUDITOR_GITHUB_REPOSITORY"),
        githubWorkflow: mustEnv("CODE_AUDITOR_GITHUB_WORKFLOW") || "cloud-benchmark.yml",
        githubRef: mustEnv("CODE_AUDITOR_GITHUB_REF") || "main",
        benchmarkTimeoutMs: Number(mustEnv("CODE_AUDITOR_GITHUB_TIMEOUT_MS") || 300_000),
      },
    }),
  });
  const jobId = job?.[0]?.id;
  if (!jobId) throw new Error("Job insert returned no id.");

  await rest("solve_job_images", {
    method: "POST",
    body: JSON.stringify({
      job_id: jobId,
      session_id: sessionId,
      position: 0,
      storage_bucket: BUCKET,
      storage_path: uploaded.objectPath,
      file_name: "vision-fixture.png",
      bytes: uploaded.bytes.length,
      mime: "image/png",
      width: 624,
      height: 236,
    }),
  });
  await rest("solve_job_events", {
    method: "POST",
    body: JSON.stringify({
      job_id: jobId,
      level: "info",
      phase: "queued",
      message: "Live smoke Council job queued.",
      payload: { imageCount: 1, source: "scripts/live-smoke.mjs" },
    }),
  });

  return { sessionId, jobId };
}

async function solveSmokeJob() {
  if (!SHOULD_SOLVE) {
    warn("Cloud solve", "--no-solve was passed");
    return;
  }
  if (!mustEnv("TOKENROUTER_API_KEY")) {
    warn("Cloud solve", "TOKENROUTER_API_KEY is missing");
    return;
  }
  process.env.CODE_AUDITOR_WORKER_SOLVERS = "2";
  process.env.CODE_AUDITOR_WORKER_JUDGES = "1";
  process.env.CODE_AUDITOR_NOTIFY_COMPLETED ||= "true";
  process.env.CODE_AUDITOR_EXECUTION_PROVIDER ||= "local";
  process.env.CODE_AUDITOR_TOKENROUTER_MIN_DELAY_MS ||= "13000";

  const created = await timed("Queued smoke solve job", createSmokeJob);
  if (!created) return;
  console.log(dim(`       job ${created.jobId}`));

  const before = Date.now();
  await timed("Worker tick completed", async () => {
    const worker = await import(pathToFileURL(path.join(ROOT, "scripts", "cloud-worker.mjs")).href);
    const worked = await worker.tick();
    if (!worked) throw new Error("worker found no queued job");
  });

  const rows = await timed("Loaded finished job", async () => {
    const row = await rest(`solve_jobs?id=eq.${created.jobId}&select=id,status,progress_phase,error,result_summary,finished_at`);
    if (!row?.[0]) throw new Error("job missing after worker tick");
    return row;
  });
  const status = rows?.[0]?.status;
  if (status) console.log(dim(`       status ${status}; elapsed ${Date.now() - before}ms`));
  await timed("Loaded Council report", async () => {
    if (status !== "completed") throw new Error(`job ended as ${status}`);
    const report = await rest(`council_reports?job_id=eq.${created.jobId}&select=winner,markdown`);
    if (!report?.[0]?.markdown) throw new Error("completed job has no report markdown");
  });
}

section("1. environment");
const loaded = loadDotEnv(ENV_PATH);
ok(".development.env loaded", loaded);
ok("SUPABASE_URL present", Boolean(mustEnv("SUPABASE_URL")));
ok("Supabase service role present", Boolean(serviceKey()));
ok("APNs path file present", !mustEnv("APNS_PRIVATE_KEY_PATH") || existsSync(path.resolve(ROOT, mustEnv("APNS_PRIVATE_KEY_PATH"))));
if (!mustEnv("E2B_API_KEY")) warn("E2B key", "missing; smoke solve will fall back to local execution");

section("2. external services");
if (mustEnv("SUPABASE_URL") && serviceKey()) {
  await timed("Supabase REST reachable", async () => {
    await rest("sessions?select=id&limit=1");
  });
  await storageRoundTrip();
} else {
  warn("Supabase checks", "missing SUPABASE_URL or service role");
}
await telegramCheck();
await apnsCheck();
ok("Sentry DSN configured", Boolean(mustEnv("SENTRY_DSN")));

section("3. cloud solve");
await solveSmokeJob();

console.log(
  failures
    ? red(`\n${failures} live smoke check(s) failed in ${Date.now() - startedAll}ms.\n`)
    : green(`\nLive smoke checks passed in ${Date.now() - startedAll}ms.\n`)
);

process.exit(failures ? 1 : 0);
