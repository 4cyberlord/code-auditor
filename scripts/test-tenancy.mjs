#!/usr/bin/env node
/**
 * Can a second account see or touch the first account's work?
 *
 *   npm run test:tenancy
 *
 * `tests/tenancy.test.ts` reads `ops.ts` and checks every query carries an owner
 * filter. That is a lint. This is the proof: it creates a real second account
 * that owns nothing, mints it a real session token, and then asks the server for
 * the first account's rows *by their actual ids*. Every answer must be empty.
 *
 * ## On the destructive operations
 *
 * `sessions.delete`, `sessions.update` and `screenshots.remove` change data, so
 * pointing them at your real rows would mean a broken filter is discovered by
 * losing a session. Instead this creates one throwaway session owned by you,
 * lets the probe attack that, and then checks it survived untouched. If scoping
 * is broken the only casualty is a row this script made ten seconds earlier.
 *
 * Everything it creates, it removes.
 */

import { createHash, randomBytes } from "node:crypto";
import "./lib/config.mjs";

const API = (process.env.COUNCIL_EDITOR_API_URL || "").trim();
const KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
const URL_ = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const SERVICE = (
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ""
).trim();

if (!API || !KEY || !URL_ || !SERVICE) {
  console.error("Need COUNCIL_EDITOR_API_URL, the publishable key, SUPABASE_URL and the service role key.");
  process.exit(2);
}

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? g("ok  ") : r("FAIL")} ${name}${cond ? "" : `  ${extra}`}`);
  if (!cond) failed++;
};

const svc = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" };

async function db(path, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...svc, ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function callAs(token, op, args = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: KEY, authorization: `Bearer ${token}` },
    body: JSON.stringify({ op, args }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON reply is itself a finding */
  }
  return { status: res.status, body };
}

const PROBE = "tenancy-probe";
const MARKER = "tenancy probe target — safe to delete";
let probeUserId = null;
let probeToken = null;
let targetSessionId = null;

async function cleanup() {
  try {
    if (targetSessionId) await db(`sessions?id=eq.${targetSessionId}`, { method: "DELETE" });
    // The probe creates a session of its own in section 3. Delete it explicitly
    // rather than relying on the account delete to cascade: until
    // tenancy-constrain.sql has run there is no foreign key to cascade along, so
    // the session outlives its owner — and an orphan is exactly what stops that
    // constraint from being added. The test that proves ownership works should
    // not be the thing leaving rows with no owner.
    if (probeUserId) await db(`sessions?owner_id=eq.${probeUserId}`, { method: "DELETE" });
    if (probeUserId) await db(`app_users?id=eq.${probeUserId}`, { method: "DELETE" });
  } catch (err) {
    console.error(r(`\nCleanup failed: ${err.message}`));
    console.error("Remove the tenancy-probe account and any 'tenancy probe target' session by hand.\n");
  }
}

try {
  console.log(`\nTenancy proof · ${URL_.replace(/^https:\/\//, "")}\n`);

  // ---------------------------------------------------------------- setup
  const owner = (await db("app_users?select=id,username&order=created_at&limit=1"))?.[0];
  if (!owner) throw new Error("No account exists yet — sign in once first.");
  console.log(dim(`  owner: ${owner.username}`));

  // A second account that owns nothing. The pin_hash is deliberate nonsense:
  // this account is never signed into, it is handed a token directly, so there
  // must be no PIN that opens it.
  await db(`app_users?username=eq.${PROBE}`, { method: "DELETE" }).catch(() => {});
  const created = await db("app_users", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ username: PROBE, pin_hash: "not-a-hash-this-account-cannot-be-signed-into" }),
  });
  probeUserId = created[0].id;

  // The server verifies a bearer token by SHA-256 against app_sessions, so a
  // token is exactly this: a random string whose hash we store.
  const raw = randomBytes(32).toString("hex");
  probeToken = raw;
  await db("app_sessions", {
    method: "POST",
    body: JSON.stringify({
      user_id: probeUserId,
      token_hash: createHash("sha256").update(raw).digest("hex"),
      label: "tenancy probe",
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
  console.log(dim(`  probe: ${PROBE}, owns nothing\n`));

  const who = await callAs(probeToken, "auth.whoami");
  check("the probe is recognised as itself", who.body?.data?.username === PROBE, JSON.stringify(who.body));

  // ------------------------------------------------- the owner's real ids
  const [aSession] = await db(`sessions?owner_id=eq.${owner.id}&select=id&limit=1`);
  const [aRun] = await db(`runs?owner_id=eq.${owner.id}&select=id&limit=1`);
  const [aJob] = await db(`solve_jobs?owner_id=eq.${owner.id}&select=id&limit=1`);
  const [aShot] = await db(
    `screenshots?owner_id=eq.${owner.id}&storage_path=not.is.null&select=id,storage_bucket,storage_path&limit=1`
  );

  // ------------------------------------------------------- reads must be empty
  console.log("\n1. the probe can read nothing of yours");

  const mine = await callAs(probeToken, "sessions.list", { status: "active" });
  check("sessions.list is empty", Array.isArray(mine.body?.data) && mine.body.data.length === 0,
    `saw ${mine.body?.data?.length} session(s)`);

  const jobs = await callAs(probeToken, "jobs.list", { status: "all" });
  check("jobs.list is empty", Array.isArray(jobs.body?.data) && jobs.body.data.length === 0,
    `saw ${jobs.body?.data?.length} job(s)`);

  if (aSession) {
    const shots = await callAs(probeToken, "screenshots.list", { sessionId: aSession.id });
    check("screenshots.list on your session is empty", shots.body?.data?.length === 0,
      `saw ${shots.body?.data?.length}`);
    const runs = await callAs(probeToken, "runs.list", { sessionId: aSession.id });
    check("runs.list on your session is empty", runs.body?.data?.length === 0,
      `saw ${runs.body?.data?.length}`);
  }
  if (aRun) {
    const run = await callAs(probeToken, "runs.get", { runId: aRun.id });
    check("runs.get on your run is a 404", run.status === 404, `got ${run.status}`);
  }
  if (aJob) {
    const ev = await callAs(probeToken, "jobs.events", { jobId: aJob.id });
    check("jobs.events on your job is empty", ev.body?.data?.length === 0, `saw ${ev.body?.data?.length}`);
    const im = await callAs(probeToken, "jobs.images", { jobId: aJob.id });
    check("jobs.images on your job is empty", im.body?.data?.length === 0, `saw ${im.body?.data?.length}`);
    const rep = await callAs(probeToken, "reports.get", { jobId: aJob.id });
    check("reports.get on your job is null", !rep.body?.data, JSON.stringify(rep.body?.data)?.slice(0, 60));
  }
  if (aShot) {
    const signed = await callAs(probeToken, "storage.sign", {
      path: aShot.storage_path,
      bucket: aShot.storage_bucket,
    });
    check("storage.sign refuses your screenshot", signed.status === 404 && !signed.body?.data?.url,
      `got ${signed.status}`);
  }

  // ------------------------------------------------------ writes must not land
  console.log("\n2. the probe can change nothing of yours");
  const target = await db("sessions", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ title: MARKER, owner_id: owner.id }),
  });
  targetSessionId = target[0].id;

  await callAs(probeToken, "sessions.update", { id: targetSessionId, title: "taken" });
  await callAs(probeToken, "sessions.setStatus", { id: targetSessionId, status: "archived" });
  await callAs(probeToken, "sessions.delete", { id: targetSessionId });

  const after = await db(`sessions?id=eq.${targetSessionId}&select=id,title,status`);
  check("your session still exists", after.length === 1, "it was deleted");
  check("its title is unchanged", after[0]?.title === MARKER, `became ${JSON.stringify(after[0]?.title)}`);
  check("its status is unchanged", after[0]?.status === "active", `became ${after[0]?.status}`);

  // A row the probe genuinely owns, to prove the filter is scoping rather than
  // simply refusing everything — a test that passes because nothing works at all
  // is worth nothing.
  console.log("\n3. and can still use its own account");
  const own = await callAs(probeToken, "sessions.create", { title: "probe's own session" });
  check("the probe can create its own session", own.status === 200 && own.body?.data?.id, JSON.stringify(own.body));
  const ownList = await callAs(probeToken, "sessions.list", { status: "active" });
  check("and sees exactly that one", ownList.body?.data?.length === 1, `saw ${ownList.body?.data?.length}`);
} catch (err) {
  console.error(r(`\n${err.message}\n`));
  failed++;
} finally {
  await cleanup();
}

console.log(failed ? r(`\n${failed} failure(s)\n`) : g("\nno cross-account access — tenancy holds\n"));
process.exit(failed ? 1 : 0);
