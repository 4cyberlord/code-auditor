#!/usr/bin/env node
/**
 * Everything a finished Council job actually produced, read back out of Supabase.
 *
 *   node scripts/inspect-run.mjs <job-id>
 *   node scripts/inspect-run.mjs --last
 *   node scripts/inspect-run.mjs --last --code      # include every candidate's source
 *   node scripts/inspect-run.mjs --last --harness   # include the generated test suites
 *
 * The batch runner's own report keeps the synthesis and little else, and the
 * synthesis is written by a model — it can be wrong about why something failed.
 * This reads the stored evidence instead: what each solver wrote, in what
 * language, what the generated harness actually was, and what the runner's
 * stderr said. When a report blames "a codespace timeout" and the stderr says
 * the class had no main method, this is where you find that out.
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

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL_BASE || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(2);
}

async function rest(p) {
  const res = await fetch(`${URL_BASE}/rest/v1/${p}`, {
    headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

const args = process.argv.slice(2);
const wantCode = args.includes("--code");
const wantHarness = args.includes("--harness");
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;

let jobId = args.find((a) => !a.startsWith("--"));
if (!jobId || args.includes("--last")) {
  const [latest] = await rest("solve_jobs?select=id&order=created_at.desc&limit=1");
  jobId = latest?.id;
}
if (!jobId) {
  console.error("No job found. Pass a job id or run a job first.");
  process.exit(2);
}

const [job] = await rest(`solve_jobs?id=eq.${jobId}&select=*`);
const [stored] = (await rest(`council_reports?job_id=eq.${jobId}&select=winner,report`)) ?? [];
const report = stored?.report ?? {};

console.log(b(`\nJob ${jobId}`));
console.log(`  status ${job?.status} · phase ${job?.progress_phase} · winner ${stored?.winner || "(none)"}`);
if (job?.error) console.log(`  ${r(job.error)}`);

// --- what each solver wrote -------------------------------------------------
console.log(b("\nCandidates"));
for (const c of report.candidates ?? []) {
  const lang = c.final?.language ?? "";
  const kind = c.final?.kind ?? (c.error ? "(failed)" : "(no final block)");
  const bytes = c.final?.code ? Buffer.byteLength(c.final.code, "utf8") : 0;
  console.log(`  ${c.letter}  ${String(c.model).padEnd(30)} ${String(kind).padEnd(10)} ${String(lang).padEnd(12)} ${bytes ? `${bytes} B` : ""}`);
  if (c.error) console.log(`     ${r(c.error)}`);
  if (wantCode && c.final?.code) {
    console.log(dim("     ---"));
    for (const line of c.final.code.split("\n")) console.log(dim(`     ${line}`));
    console.log(dim("     ---"));
  }
}

// --- what the harness said --------------------------------------------------
console.log(b("\nBenchmark runs"));
for (const run of Object.values(report.runs ?? {})) {
  const verdict = run.ok ? g("ok") : r("fail");
  console.log(
    `  ${run.letter}  ${verdict.padEnd(13)} ${String(run.runtime || "-").padEnd(22)} ` +
      `passed ${run.passed} failed ${run.failed}  ${run.durationMs}ms  ${run.note || ""}`
  );
  if (run.stderr) for (const line of String(run.stderr).split("\n").slice(0, 6)) console.log(dim(`       ${line}`));
  if (run.remote) console.log(dim(`       remote: ${run.remote.runtime} ${run.remote.note || ""}`));
}

// --- the tests those runs were judged against -------------------------------
console.log(b("\nGenerated suites"));
for (const suite of report.suites ?? []) {
  console.log(`  ${suite.language} — ${Buffer.byteLength(suite.harness, "utf8")} B`);
  if (wantHarness) {
    console.log(dim("  ---"));
    for (const line of suite.harness.split("\n")) console.log(dim(`  ${line}`));
    console.log(dim("  ---"));
  }
}
if (!wantHarness && (report.suites ?? []).length) {
  console.log(dim("  (--harness to print them — the failing case usually lives here)"));
}

console.log(b("\nJudges"));
for (const j of report.judges ?? []) {
  console.log(`  ${String(j.model).padEnd(30)} ${j.emphasis}  ${j.error ? r(j.error) : g("reported")}`);
}
console.log("");
