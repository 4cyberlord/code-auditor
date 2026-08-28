#!/usr/bin/env node
/**
 * Does the deployed API actually work, and does it refuse what it should?
 *
 *   node scripts/test-server-api.mjs
 *
 * Two halves, and the second is the one that matters. Anyone can check that a
 * server answers; the reason this function exists is to stop a laptop holding
 * project admin, so the tests that count are the ones proving it says no —
 * without a key, without a token, with a bad token, and to an operation that
 * does not exist.
 *
 * No secret is ever printed. The token and the key are read from the
 * environment and only their presence is reported.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

for (const file of [".development.env", ".env"]) {
  const full = path.join(process.cwd(), file);
  if (!existsSync(full)) continue;
  for (const raw of readFileSync(full, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

import { createHash, randomBytes } from "node:crypto";

const URL_ = (process.env.COUNCIL_EDITOR_API_URL || "").trim();
const KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
const SERVICE = (
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ""
).trim();
const PROJECT = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");

/**
 * The signed-in half used to need `COUNCIL_EDITOR_TOKEN` exported by hand, and
 * the moment the owner account was reset that token went stale — so the suite
 * quietly skipped its most important half and still printed "all checks passed".
 * A test that silently tests less is worse than one that fails.
 *
 * So when no token is supplied, mint a short-lived one for the owner and revoke
 * it at the end. A bearer token is verified by SHA-256 against `app_sessions`,
 * so minting one is just storing the hash of a random string.
 */
let TOKEN = (process.env.COUNCIL_EDITOR_TOKEN || "").trim();
let mintedSessionId = null;

async function mintOwnerToken() {
  if (TOKEN || !SERVICE || !PROJECT) return;
  const headers = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" };
  const users = await fetch(`${PROJECT}/rest/v1/app_users?select=id&order=created_at&limit=1`, { headers });
  if (!users.ok) return;
  const owner = (await users.json())?.[0];
  if (!owner) return;

  const raw = randomBytes(32).toString("hex");
  const res = await fetch(`${PROJECT}/rest/v1/app_sessions`, {
    method: "POST",
    headers: { ...headers, prefer: "return=representation" },
    body: JSON.stringify({
      user_id: owner.id,
      token_hash: createHash("sha256").update(raw).digest("hex"),
      label: "test:api (temporary)",
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
  if (!res.ok) return;
  mintedSessionId = (await res.json())?.[0]?.id ?? null;
  TOKEN = raw;
}

async function revokeMintedToken() {
  if (!mintedSessionId) return;
  await fetch(`${PROJECT}/rest/v1/app_sessions?id=eq.${mintedSessionId}`, {
    method: "DELETE",
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
  }).catch(() => {});
}

await mintOwnerToken();

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? g("ok  ") : r("FAIL")} ${name}${cond ? "" : `  ${extra}`}`);
  if (!cond) failed++;
};

if (!URL_) {
  console.error("Set COUNCIL_EDITOR_API_URL to the deployed function URL.");
  process.exit(2);
}
console.log(`\nAPI ${URL_}`);
console.log(
  dim(
    `publishable key ${KEY ? "present" : "MISSING"} · session token ${
      TOKEN ? (mintedSessionId ? "minted for this run" : "present") : "MISSING"
    }`
  )
);

async function post(op, args = {}, { key = KEY, token = TOKEN } = {}) {
  const headers = { "content-type": "application/json" };
  if (key) headers.apikey = key;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify({ op, args }) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON reply is itself the finding */
  }
  return { status: res.status, body, text };
}

console.log("\n1. it refuses what it should");
{
  const noKey = await post("auth.whoami", {}, { key: "" });
  check("no project key is refused", noKey.status === 401, `got ${noKey.status}`);

  if (KEY) {
    const noToken = await post("auth.whoami", {}, { token: "" });
    check(
      "a project key alone is not identity",
      noToken.status === 401,
      `got ${noToken.status} — the apikey is in the shipped app, so this must never pass`
    );

    const badToken = await post("auth.whoami", {}, { token: "not-a-real-token" });
    check("an unknown token is refused", badToken.status === 401, `got ${badToken.status}`);
    check(
      "and it does not say which kind of wrong",
      badToken.body?.error === "That sign-in is no longer valid." ||
        badToken.body?.error === "Sign in first.",
      JSON.stringify(badToken.body?.error)
    );
  }
}

if (KEY && TOKEN) {
  console.log("\n2. it answers what it should");
  const who = await post("auth.whoami");
  check("a signed-in Mac is recognised", who.status === 200 && Boolean(who.body?.data?.username), JSON.stringify(who.body));
  if (who.body?.data?.username) console.log(dim(`     signed in as ${who.body.data.username}`));

  const sessions = await post("sessions.list", { status: "active" });
  check("sessions come back", sessions.status === 200 && Array.isArray(sessions.body?.data), `${sessions.status}`);
  if (Array.isArray(sessions.body?.data)) {
    console.log(dim(`     ${sessions.body.data.length} active session(s)`));
  }

  const jobs = await post("jobs.list", { status: "all" });
  check("cloud jobs come back", jobs.status === 200 && Array.isArray(jobs.body?.data), `${jobs.status}`);

  // The shape is the contract now, not an implementation detail. Rust
  // deserialises these straight into `RunSummary` / `StoredResponse`, and serde
  // refuses a missing field outright — so a rename here is a runtime failure in
  // the app, and this is the cheapest place to catch it.
  console.log("\n2b. history comes back in the shape the desktop expects");
  const RUN_KEYS = [
    "id", "sessionId", "mode", "asked", "startedAt", "finishedAt",
    "answered", "verdict", "reliability",
  ];
  const RESPONSE_KEYS = [
    "id", "provider", "model", "attemptId", "status", "body", "finalKind",
    "finalLanguage", "finalAnswer", "finalCode", "finalClaims", "complexity",
    "confidence", "wellFormed", "inputTokens", "outputTokens", "elapsedMs", "error",
  ];
  const missing = (obj, keys) => keys.filter((k) => !(k in (obj ?? {})));

  let probed = null;
  for (const session of sessions.body?.data ?? []) {
    const runs = await post("runs.list", { sessionId: session.id });
    if (runs.status !== 200) {
      check(`runs.list works for ${session.id}`, false, `${runs.status}`);
      break;
    }
    if (Array.isArray(runs.body?.data) && runs.body.data.length > 0) {
      probed = runs.body.data[0];
      break;
    }
  }

  if (!probed) {
    console.log(dim("     no session has a saved run yet — nothing to shape-check"));
  } else {
    const gaps = missing(probed, RUN_KEYS);
    check("a run summary has every field RunSummary needs", gaps.length === 0, `missing ${gaps}`);
    check("answered is a number", typeof probed.answered === "number", typeof probed.answered);

    const detail = await post("runs.get", { runId: probed.id });
    check("one run reads back in full", detail.status === 200, `${detail.status}`);
    const d = detail.body?.data;
    check(
      "it is { run, responses, verdict }",
      Boolean(d?.run) && Array.isArray(d?.responses) && "verdict" in (d ?? {}),
      JSON.stringify(Object.keys(d ?? {}))
    );
    const runGaps = missing(d?.run, RUN_KEYS);
    check("the nested run summary is complete", runGaps.length === 0, `missing ${runGaps}`);
    if (d?.responses?.length) {
      const rGaps = missing(d.responses[0], RESPONSE_KEYS);
      check("a stored answer is complete", rGaps.length === 0, `missing ${rGaps}`);
      check(
        "finalClaims is an array, never null",
        Array.isArray(d.responses[0].finalClaims),
        String(d.responses[0].finalClaims)
      );
    } else {
      console.log(dim("     that run stored no answers — response shape unchecked"));
    }
    if (d?.verdict) {
      const vGaps = missing(d.verdict, ["verdict", "headline", "detail", "reliability", "outliers", "representative", "judgeProvider", "judgeText"]);
      check("the verdict is complete", vGaps.length === 0, `missing ${vGaps}`);
    } else {
      console.log(dim("     that run stored no verdict — verdict shape unchecked"));
    }
  }

  // Same reasoning as the history shapes above: Rust deserialises these straight
  // into Session / Screenshot / SolveJob / CouncilReportSummary, and serde
  // refuses a missing field outright. A rename here is a runtime failure in the
  // app, and this is the cheapest place to catch it.
  console.log("\n2c. sessions, screenshots and jobs match the desktop's structs");
  const SESSION_KEYS = ["id", "title", "note", "context", "status", "createdAt", "updatedAt", "screenshotCount", "runCount"];
  const SHOT_KEYS = ["id", "sessionId", "position", "localPath", "storagePath", "fileName", "bytes", "mime", "capturedAt", "purged"];
  const JOB_KEYS = ["id", "sessionId", "mode", "status", "progressPhase", "settingsSnapshot", "error", "resultSummary", "createdAt", "claimedAt", "startedAt", "finishedAt", "updatedAt"];

  const firstSession = sessions.body?.data?.[0];
  if (firstSession) {
    const gaps = missing(firstSession, SESSION_KEYS);
    check("a session is complete", gaps.length === 0, `missing ${gaps}`);
    check("counts are numbers", typeof firstSession.screenshotCount === "number", typeof firstSession.screenshotCount);

    const shots = await post("screenshots.list", { sessionId: firstSession.id });
    check("screenshots come back", shots.status === 200 && Array.isArray(shots.body?.data), `${shots.status}`);
    if (shots.body?.data?.length) {
      const g2 = missing(shots.body.data[0], SHOT_KEYS);
      check("a screenshot is complete", g2.length === 0, `missing ${g2}`);
      check("purged is a boolean", typeof shots.body.data[0].purged === "boolean", "purged must never be null");
    } else {
      console.log(dim("     that session has no screenshots — shape unchecked"));
    }
  }

  const firstJob = jobs.body?.data?.[0];
  if (firstJob) {
    const g3 = missing(firstJob, JOB_KEYS);
    check("a solve job is complete", g3.length === 0, `missing ${g3}`);
    check("settingsSnapshot is an object", typeof firstJob.settingsSnapshot === "object", "serde needs a value here");

    const report = await post("reports.get", { jobId: firstJob.id });
    check("reports.get answers", report.status === 200, `${report.status}`);
    if (report.body?.data) {
      const g4 = missing(report.body.data, ["id", "jobId", "sessionId", "winner", "synthesis", "markdown", "report", "createdAt"]);
      check("a council report is complete", g4.length === 0, `missing ${g4}`);
    } else {
      console.log(dim("     that job has no report — shape unchecked"));
    }
  }

  // The two ops most recently reshaped, and the one most recently added. These
  // are exactly the shapes that break silently: serde refuses a missing field at
  // runtime, and nothing in a deploy tells you the names changed.
  console.log("\n2d. job events, job images and purge");
  const EVENT_KEYS = ["id", "jobId", "level", "phase", "message", "payload", "createdAt"];
  const IMAGE_KEYS = [
    "id", "jobId", "sessionId", "position", "storageBucket", "storagePath",
    "fileName", "bytes", "mime", "width", "height", "createdAt",
  ];

  if (firstJob) {
    const events = await post("jobs.events", { jobId: firstJob.id });
    check("job events come back", events.status === 200 && Array.isArray(events.body?.data), `${events.status}`);
    if (events.body?.data?.length) {
      const g = missing(events.body.data[0], EVENT_KEYS);
      check("a job event is complete", g.length === 0, `missing ${g}`);
      check("payload is an object", typeof events.body.data[0].payload === "object", "serde needs a value");
    } else {
      console.log(dim("     that job logged no events — shape unchecked"));
    }

    const imgs = await post("jobs.images", { jobId: firstJob.id });
    check("job images come back", imgs.status === 200 && Array.isArray(imgs.body?.data), `${imgs.status}`);
    if (imgs.body?.data?.length) {
      const g = missing(imgs.body.data[0], IMAGE_KEYS);
      check("a job image is complete", g.length === 0, `missing ${g}`);
    } else {
      console.log(dim("     that job has no images — shape unchecked"));
    }
  }

  // Pointed at a session id that cannot exist, so this proves the operation is
  // deployed and scoped without purging anything real. Calling it on a live
  // session would delete screenshots to check that deleting screenshots works.
  const purge = await post("screenshots.purge", {
    sessionId: "00000000-0000-0000-0000-000000000000",
  });
  check(
    "screenshots.purge is deployed and returns a list",
    purge.status === 200 && Array.isArray(purge.body?.data),
    `${purge.status} ${JSON.stringify(purge.body?.error)}`
  );
  check("and purged nothing it does not own", purge.body?.data?.length === 0, `${purge.body?.data?.length}`);

  console.log("\n3. bad input is refused, not swallowed");
  const unknown = await post("nope.nothing");
  check("an unknown operation is named", unknown.status === 400 && /Unknown operation/.test(unknown.body?.error ?? ""), JSON.stringify(unknown.body));

  const badId = await post("runs.get", { runId: "not-a-uuid" });
  check("a malformed id is rejected", badId.status === 400, `got ${badId.status}`);

  // Refused is the property; which layer refuses is not ours to fix. The CDN in
  // front of Supabase answers 403 to a classic traversal string before the
  // function is ever invoked, so asserting 400 here was asserting that our code
  // got the chance to say no. What matters is that nobody gets a signed URL.
  const traversal = await post("storage.sign", { path: "../../etc/passwd" });
  check(
    "a path traversal is refused",
    traversal.status >= 400 && !traversal.body?.data?.url,
    `got ${traversal.status}`
  );
  if (traversal.status === 403 && !traversal.body) {
    console.log(dim("     refused upstream by the CDN, before the function ran"));
  }

  // ...so these three prove our own gate, using shapes no WAF signature eats.
  const rooted = await post("storage.sign", { path: "/private/secrets.png" });
  check("an absolute path is rejected", rooted.status === 400, `got ${rooted.status}`);

  const badBucket = await post("storage.sign", { path: "a/b.png", bucket: "not a bucket!" });
  check("a bogus bucket is rejected", badBucket.status === 400, `got ${badBucket.status}`);

  // The one that matters most: a perfectly well-formed path this project never
  // stored. Signing runs with the service-role key, so "looks fine" must not be
  // enough — it has to be a screenshot we actually put there.
  const unowned = await post("storage.sign", { path: "definitely/not/ours-9d3f.png" });
  check(
    "an unowned object is not signed",
    unowned.status === 404 && !unowned.body?.data?.url,
    `got ${unowned.status} ${JSON.stringify(unowned.body?.error)}`
  );
} else {
  console.log(dim("\nSet SUPABASE_PUBLISHABLE_KEY and COUNCIL_EDITOR_TOKEN to test the signed-in half."));
}

// The one that matters if config now lives in a table. RLS is on with no policy,
// so `anon` — the key that ships inside the app — must come back with nothing.
// Postgrest answers 200 and an empty array rather than a 403 in that case, so
// "it did not error" is not the property; "it returned no rows" is.
if (KEY) {
  console.log("\n4. the shipped key cannot read the config table");
  const project = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  if (!project) {
    console.log(dim("     SUPABASE_URL not set — skipped"));
  } else {
    const res = await fetch(`${project}/rest/v1/app_config?select=key&limit=5`, {
      headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
    });
    const text = await res.text();
    let rows = null;
    try {
      rows = JSON.parse(text);
    } catch {
      /* an error body is a refusal too */
    }
    const leaked = Array.isArray(rows) ? rows.length : 0;
    check(
      "anon reads no rows from app_config",
      leaked === 0,
      `${res.status} returned ${leaked} row(s) — RLS is not on`
    );
    if (res.status === 404) console.log(dim("     no app_config table yet — nothing to leak"));
  }
}

await revokeMintedToken();

// Saying "all checks passed" after skipping the signed-in half is the failure
// mode this line exists to prevent.
if (!TOKEN) {
  console.log(
    r("\nThe signed-in half did not run.") +
      "\nNo token, and no service role key to mint one with. Nothing above proves\n" +
      "that a signed-in Mac can actually read its own data.\n"
  );
  process.exit(1);
}

console.log(failed ? r(`\n${failed} failure(s)\n`) : g("\nall server API checks passed\n"));
process.exit(failed ? 1 : 0);
