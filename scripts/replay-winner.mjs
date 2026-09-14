#!/usr/bin/env node
/**
 * What the deterministic winner layer would have done to runs that already happened.
 *
 *   node scripts/replay-winner.mjs                 # the last 20 stored reports
 *   node scripts/replay-winner.mjs --limit 100
 *   node scripts/replay-winner.mjs --job <job-id>
 *   node scripts/replay-winner.mjs --changed       # only the runs whose winner moves
 *   node scripts/replay-winner.mjs --fixture council-runs/batch-….json
 *
 * The parsers and the winner aggregation are new code sitting on the last step
 * of an expensive pipeline, and the honest question about them is not "do they
 * pass their unit tests" — they do — but "do they work on what these models
 * actually write". A live batch answers that four problems at a time, an hour a
 * batch. Every Council run ever stored answers it in about a second, for free,
 * and against real model output rather than fixtures written by the same person
 * who wrote the parser.
 *
 * Two things come back. First, parse health: how many stored syntheses yield a
 * WINNER and an APPROACH, how many judge reports yield a usable RANKING. A
 * parser that reads 40% of real reports is a parser that quietly falls back to
 * the synthesis on the other 60%, and nothing in production would have said so.
 * Second, the decisions that would change — a winner rescued from a run that
 * recorded none, or moved because the judges' count disagreed with the prose.
 * Read those by hand before trusting the layer: they are the whole behavioural
 * risk of the change, and there are usually few enough to read.
 *
 * Nothing is written back. This reads `council_reports` and prints.
 */

// Configuration lives in the database now. This import has a top-level await,
// so app_config is merged into process.env before anything below reads it.
import "./lib/config.mjs";

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const LIMIT = Number(flag("--limit", "20"));
const JOB = flag("--job", "");
const ONLY_CHANGED = args.includes("--changed");

const c = (code, s) => (process.stdout.isTTY ? `[${code}m${s}[0m` : s);
const b = (s) => c("1", s);
const g = (s) => c("32", s);
const y = (s) => c("33", s);
const dim = (s) => c("2", s);

async function rest(p) {
  let res;
  try {
    res = await fetch(`${URL_BASE}/rest/v1/${p}`, {
      headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
    });
  } catch (err) {
    // A stack trace from undici tells you nothing you can act on. The two
    // things that are actually wrong are always the URL or the network.
    console.error(`Could not reach ${URL_BASE}: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Check SUPABASE_URL in .development.env, or pass --fixture to replay from a file.");
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`Supabase answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(2);
  }
  return res.json();
}

const { replayReports } = await import("./lib/replay.mjs");

// A fixture is any JSON this project already writes: a batch run's own output,
// or rows pulled from `council_reports` by hand. It exists so the replay can be
// run with no database in front of you, and so the logic has something to be
// tested against.
const FIXTURE = flag("--fixture", "");
let rows;
if (FIXTURE) {
  if (!existsSync(FIXTURE)) {
    console.error(`No such fixture: ${FIXTURE}`);
    process.exit(2);
  }
  rows = JSON.parse(readFileSync(FIXTURE, "utf8"));
} else {
  const query = JOB
    ? `council_reports?job_id=eq.${JOB}&select=job_id,created_at,winner,synthesis,report`
    : `council_reports?select=job_id,created_at,winner,synthesis,report&order=created_at.desc&limit=${LIMIT}`;
  rows = (await rest(query)) ?? [];
}

const { results, health, counts } = replayReports(rows);

if (!results.length) {
  console.log(
    FIXTURE
      ? "That fixture holds no Council report with a candidate field."
      : "No stored Council reports matched."
  );
  process.exit(0);
}

const {
  syntheses,
  synthesesParsed,
  withWinnerLine,
  withApproach,
  judgeReports,
  judgesRanked,
} = health;

// ------------------------------------------------------------------ output

console.log(b(`\nReplayed ${results.length} stored Council report(s)\n`));

console.log(b("Parse health"));
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");
console.log(`  syntheses that parsed into fields   ${pct(synthesesParsed, syntheses)} (${synthesesParsed}/${syntheses})`);
console.log(`  syntheses with a readable WINNER    ${pct(withWinnerLine, syntheses)}`);
console.log(`  syntheses with a readable APPROACH  ${pct(withApproach, syntheses)}`);
console.log(`  judge reports with a RANKING        ${pct(judgesRanked, judgeReports)} (${judgesRanked}/${judgeReports})`);
console.log(
  dim(
    "  A low RANKING rate means the tally is mostly empty and the winner quietly\n" +
      "  falls back to the synthesis — working, but not doing anything."
  )
);

console.log(b("\nWhat the layer would change"));
console.log(`  unchanged  ${counts.same ?? 0}`);
console.log(`  rescued    ${counts.rescued ?? 0}   ${dim("(no winner recorded; a gate-passing candidate the judges ranked)")}`);
console.log(`  moved      ${counts.moved ?? 0}   ${dim("(the judges' count outranked the synthesis' pick)")}`);
console.log(`  withdrawn  ${counts.withdrawn ?? 0}   ${dim("(read these first — a winner the replay refuses to keep)")}`);

const shown = ONLY_CHANGED ? results.filter((x) => x.changed) : results;
console.log(b("\nRuns"));
for (const x of shown) {
  const mark = x.kind === "same" ? dim("same    ") : x.kind === "withdrawn" ? y("withdrawn") : g(`${x.kind.padEnd(8)}`);
  console.log(
    `  ${mark} ${x.jobId}  ${x.stored || "-"} → ${x.replayed || "-"}  ${dim(
      `source ${x.source} · gates ${JSON.stringify(x.gates)} · tally ${x.tally || "(none)"} · judges ranked ${x.judgesRanked}/${x.judgesTotal}`
    )}`
  );
  if (x.why) console.log(dim(`      ${x.why}`));
}

const OUT_DIR = path.join(process.cwd(), "council-runs");
mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      parseHealth: health,
      counts,
      results,
    },
    null,
    2
  )
);
console.log(dim(`\nWrote ${out}\n`));
