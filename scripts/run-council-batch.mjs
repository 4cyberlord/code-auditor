#!/usr/bin/env node
/**
 * Drives real problems through the real Council, end to end, on this machine.
 *
 *   node scripts/run-council-batch.mjs bench-problems/lc4.png bench-problems/lc42.png
 *   node scripts/run-council-batch.mjs --all
 *
 * Every step is the production path, not a simulation: the image is uploaded to
 * Supabase Storage exactly as a capture is, a `solve_jobs` row is queued exactly
 * as the app queues one, and `cloud-worker.tick()` is the same worker that
 * serves the desktop app. Nothing here reimplements the pipeline — if it works
 * from this script it works from the UI, and if it fails the failure is real.
 *
 * It exists because the sandbox this project is developed from cannot reach
 * TokenRouter: an egress allowlist refuses the host outright
 * (`x-deny-reason: host_not_allowed`), with or without the proxy. Your Mac has
 * no such restriction. So the runner lives here, you press it, and the full
 * report — every model's answer, its code, its complexity, the benchmark
 * numbers, every judge, the synthesis, and every error — lands in a file that
 * can be read afterwards.
 *
 * Problems run strictly one after another, never in parallel: the whole point
 * is to see each one's behaviour on its own, and the gateway's rate limit would
 * turn concurrency into a wall of 429s that says nothing about the models.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const BUCKET = "screenshots";
const OUT_DIR = path.join(ROOT, "council-runs");

// ------------------------------------------------------------------ env

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(ROOT, ".development.env"));
loadDotEnv(path.join(ROOT, ".env"));

const need = (name) => {
  const v = process.env[name];
  if (!v?.trim()) {
    console.error(`Missing ${name}. Add it to .development.env and run again.`);
    process.exit(2);
  }
  return v.trim();
};

const SUPABASE_URL = need("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = need("SUPABASE_SERVICE_ROLE_KEY");

const H = {
  apikey: SERVICE_KEY,
  authorization: `Bearer ${SERVICE_KEY}`,
  "content-type": "application/json",
};

async function rest(pathname, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: { ...H, prefer: "return=representation", ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`REST ${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * PostgREST publishes the live schema at the API root. Reading it once means an
 * insert never has to guess a column name: anything the table does not actually
 * have is dropped before the request instead of coming back as a 400, and a
 * table that is missing entirely is reported before the first problem runs
 * rather than four times over.
 */
let schemaDefinitions = null;
async function schema() {
  if (schemaDefinitions) return schemaDefinitions;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: H });
  if (!res.ok) throw new Error(`Could not read the schema: ${res.status} ${res.statusText}`);
  schemaDefinitions = (await res.json())?.definitions ?? {};
  return schemaDefinitions;
}

async function columnsOf(table) {
  const def = (await schema())[table];
  return def?.properties ? Object.keys(def.properties) : null;
}

/** Inserts a row, sending only the columns the table really has. */
async function insertRow(table, row) {
  const cols = await columnsOf(table);
  if (!cols) throw new Error(`Table "${table}" does not exist in this project.`);
  const kept = Object.fromEntries(Object.entries(row).filter(([k]) => cols.includes(k)));
  const dropped = Object.keys(row).filter((k) => !cols.includes(k));
  if (dropped.length) console.log(dim(`  (${table}: ignored ${dropped.join(", ")})`));
  return await rest(table, { method: "POST", body: JSON.stringify(kept) });
}

/** Fails loudly, once, if the tables this run depends on are not there. */
async function preflight() {
  const required = ["sessions", "solve_jobs", "solve_job_images", "solve_job_events", "council_reports"];
  const missing = [];
  for (const table of required) if (!(await columnsOf(table))) missing.push(table);
  if (missing.length) {
    throw new Error(`These tables are missing from the project: ${missing.join(", ")}`);
  }
}

// ---------------------------------------------------------------- helpers

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

const ZONE = process.env.CODE_AUDITOR_TIMEZONE || "America/Chicago";
const stamp = (d = new Date()) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: ZONE }).format(d);

/** Uploads one problem image the way a capture is uploaded. */
async function uploadImage(sessionId, file) {
  const bytes = readFileSync(file);
  const name = path.basename(file);
  const objectPath = `${sessionId}/${name}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "image/png", "x-upsert": "true" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Storage upload failed ${res.status}: ${(await res.text()).slice(0, 240)}`);
  return { objectPath, bytes: bytes.length, name };
}

/** One problem, start to finish. Returns everything worth reading afterwards. */
async function runOne(file, index, total) {
  const label = path.basename(file, ".png");
  console.log(`\n${b(`[${index}/${total}] ${label}`)}  ${dim(stamp())}`);

  const started = Date.now();
  const sessionRows = await rest("sessions", {
    method: "POST",
    body: JSON.stringify({ title: `Batch — ${label}`, status: "active" }),
  });
  const sessionId = sessionRows?.[0]?.id;
  if (!sessionId) throw new Error("session insert returned no id");
  console.log(dim(`  session ${sessionId}`));

  const up = await uploadImage(sessionId, file);
  console.log(dim(`  uploaded ${up.name} (${(up.bytes / 1024).toFixed(0)} KB)`));

  const jobRows = await rest("solve_jobs", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      mode: "council",
      status: "queued",
      progress_phase: "queued",
      settings_snapshot: {
        mode: "auto",
        maxTokens: Number(process.env.CODE_AUDITOR_BATCH_MAX_TOKENS || 4096),
        // local | e2b — CODE_AUDITOR_BATCH_EXECUTION=e2b runs the generated
        // benchmarks in an E2B sandbox instead of on this Mac. Check the
        // sandbox has a C++ toolchain first: node scripts/test-e2b.mjs
        executionProvider: process.env.CODE_AUDITOR_BATCH_EXECUTION || "local",
        // Whatever the question is written in — the default the app now ships.
        outputLanguage: process.env.CODE_AUDITOR_BATCH_LANGUAGE || "",
        benchmarkBackend: process.env.CODE_AUDITOR_BATCH_BACKEND || "actions",
        githubRepository: process.env.GITHUB_REPOSITORY || "",
      },
    }),
  });
  const jobId = jobRows?.[0]?.id;
  if (!jobId) throw new Error("job insert returned no id");

  // The worker looks its pictures up by job, not by session: it reads
  // `solve_job_images?job_id=eq.<id>`. Writing a `screenshots` row keyed by
  // session instead is what made every job in the first batch die with "the job
  // has no downloadable screenshots" — the picture was uploaded and stored, it
  // simply was not attached to anything the worker would ever look at. The row
  // has to be written after the job exists, so the foreign key has a target.
  await insertRow("solve_job_images", {
    job_id: jobId,
    session_id: sessionId,
    position: 0,
    storage_bucket: BUCKET,
    storage_path: up.objectPath,
    file_name: up.name,
    bytes: up.bytes,
    mime: "image/png",
    created_at: new Date().toISOString(),
  });

  const linked = await rest(`solve_job_images?job_id=eq.${jobId}&select=id,storage_path`);
  if (!linked?.length) throw new Error("the image row was written but the job cannot see it");
  console.log(dim(`  linked ${up.name} to the job`));
  console.log(dim(`  job ${jobId} queued — running the worker…`));

  const worker = await import(pathToFileURL(path.join(ROOT, "scripts", "cloud-worker.mjs")).href);
  const worked = await worker.tick();
  if (!worked) throw new Error("the worker found no queued job");

  const [job] = await rest(
    `solve_jobs?id=eq.${jobId}&select=id,status,progress_phase,error,result_summary,started_at,finished_at`
  );
  const [report] = (await rest(`council_reports?job_id=eq.${jobId}&select=winner,markdown`)) ?? [];
  const events =
    (await rest(`solve_job_events?job_id=eq.${jobId}&select=*&order=created_at`)) ?? [];

  const elapsed = Date.now() - started;
  console.log(
    job?.status === "completed"
      ? `  ${g("completed")} in ${(elapsed / 1000).toFixed(1)}s${report?.winner ? ` — winner ${report.winner}` : ""}`
      : `  ${r(job?.status ?? "unknown")} — ${job?.error ?? "no error recorded"}`
  );

  if (job?.status !== "completed") {
    // Say why here, not only in the file — a failed run is the one you want to
    // read straight away.
    for (const e of events.filter((x) => x.level === "warn" || x.level === "error")) {
      console.log(dim(`    ${e.level} ${e.phase}: ${e.message}`));
    }
  }

  return { label, file, sessionId, jobId, elapsedMs: elapsed, job, report, events };
}

// ------------------------------------------------------------------- main

const args = process.argv.slice(2);
const files = args.includes("--all")
  ? ["lc4", "lc42", "lc76", "lc124"].map((n) => path.join("bench-problems", `${n}.png`))
  : args.filter((a) => !a.startsWith("--"));

if (!files.length) {
  console.error("Usage: node scripts/run-council-batch.mjs --all | <image.png> [more.png ...]");
  process.exit(2);
}
for (const f of files) {
  if (!existsSync(f)) {
    console.error(`No such file: ${f}`);
    process.exit(2);
  }
}

console.log(`${b("Council batch")} — ${files.length} problem(s), one at a time`);
console.log(dim(`project ${SUPABASE_URL}`));

try {
  await preflight();
} catch (err) {
  console.error(r(`\n${err instanceof Error ? err.message : String(err)}\n`));
  process.exit(2);
}

const results = [];
for (const [i, file] of files.entries()) {
  try {
    results.push(await runOne(file, i + 1, files.length));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ${r("failed")} — ${message}`);
    results.push({ label: path.basename(file, ".png"), file, error: message });
  }
}

// ------------------------------------------------------------------ report

mkdirSync(OUT_DIR, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(OUT_DIR, `batch-${runId}.json`);
const mdPath = path.join(OUT_DIR, `batch-${runId}.md`);

writeFileSync(jsonPath, JSON.stringify({ runId, at: new Date().toISOString(), results }, null, 2));

const md = [`# Council batch — ${stamp()}`, ""];
md.push(`${results.filter((x) => x.job?.status === "completed").length} of ${results.length} completed.`, "");
for (const res of results) {
  md.push(`## ${res.label}`, "");
  if (res.error) {
    md.push(`**Failed before the worker:** ${res.error}`, "");
    continue;
  }
  md.push(
    `- job \`${res.jobId}\``,
    `- status **${res.job?.status}**${res.job?.error ? ` — ${res.job.error}` : ""}`,
    `- elapsed ${(res.elapsedMs / 1000).toFixed(1)}s`,
    `- winner: ${res.report?.winner || "(none)"}`,
    ""
  );
  const warned = res.events.filter((e) => e.level === "warn" || e.level === "error");
  if (warned.length) {
    md.push("### Warnings and errors", "");
    for (const e of warned) md.push(`- \`${e.level}\` **${e.phase}** — ${e.message}`);
    md.push("");
  }
  if (res.report?.markdown) md.push("### Report", "", res.report.markdown, "");
}
writeFileSync(mdPath, md.join("\n"));

console.log(`\n${b("Wrote")}`);
console.log(`  ${mdPath}`);
console.log(`  ${jsonPath}`);
console.log(
  results.every((x) => x.job?.status === "completed")
    ? g("\nAll problems completed.\n")
    : r("\nSome problems did not complete — see the report.\n")
);
process.exit(results.every((x) => x.job?.status === "completed") ? 0 : 1);
