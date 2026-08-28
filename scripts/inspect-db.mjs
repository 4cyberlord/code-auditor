#!/usr/bin/env node
/**
 * What is actually in the database and the bucket?
 *
 *   npm run inspect            # the latest session, in full
 *   npm run inspect -- --all   # every session, summarised
 *
 * Deliberately over Supabase's REST API rather than a Postgres driver. Three
 * reasons: it needs no new dependency, it uses the `service_role` key already in
 * the Keychain, and it is the *same* path an iPad client would take — so a pass
 * here is evidence the mobile app will be able to read this data, not just that
 * the rows exist.
 *
 * Nothing is written, nothing is deleted, and no secret is printed.
 */

// Configuration lives in the database now. This import has a top-level await,
// so app_config is merged into process.env before anything below reads it.
import "./lib/config.mjs";

import { execFileSync } from "node:child_process";

const SERVICE = "com.charles.councileditor";
const BUCKET = "screenshots";

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const ALL = process.argv.includes("--all");
const ZONE = "America/Chicago";

const when = (iso) =>
  iso
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: ZONE,
      }).format(new Date(iso))
    : "—";

function keychain(account) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Port of `project_url` in src-tauri/src/storage.rs. Password may contain `@`. */
function projectUrl(conn) {
  const host = (conn.split("@").pop() ?? "").split(/[/:]/)[0] ?? "";
  const direct = /^db\.([^.]+)\.supabase\.co$/.exec(host);
  if (direct) return `https://${direct[1]}.supabase.co`;
  if (host.endsWith(".pooler.supabase.com")) {
    const creds = conn.slice(0, conn.lastIndexOf("@"));
    const user = (creds.split("//")[1] ?? "").split(":")[0] ?? "";
    const ref = user.startsWith("postgres.") ? user.slice("postgres.".length) : "";
    if (ref && !ref.includes(".")) return `https://${ref}.supabase.co`;
  }
  return null;
}

const key = process.env.SUPABASE_SERVICE_KEY?.trim() || keychain("supabase_storage");
const conn = keychain("supabase-url");
if (!key || !conn) {
  console.error(r("\nNeed both the Supabase Storage key and the database connection string."));
  console.error("Both live in Settings → Sessions. Save them first, then run this again.\n");
  process.exit(2);
}
const base = projectUrl(conn);
if (!base) {
  console.error(r("\nCould not work out the project URL from the connection string.\n"));
  process.exit(2);
}

const H = { Authorization: `Bearer ${key}`, apikey: key };

/** One PostgREST query. Returns rows, and the total when asked to count. */
async function q(table, params = "", { count = false } = {}) {
  const res = await fetch(`${base}/rest/v1/${table}?${params}`, {
    headers: count ? { ...H, Prefer: "count=exact", Range: "0-0" } : H,
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404 || body.includes("does not exist")) {
      throw new Error(`table "${table}" is not there — has the schema been applied?`);
    }
    if (res.status === 401) throw new Error("the key was rejected (needs service_role)");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  const rows = await res.json();
  if (!count) return rows;
  const total = Number((res.headers.get("content-range") ?? "/0").split("/").pop());
  return total;
}

const wrap = (text, width = 92, indent = "     ") =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(new RegExp(`(.{1,${width}})(\\s|$)`, "g"), `${indent}$1\n`)
    .trimEnd();

console.log(`\n${b("Project")}  ${base}`);

// --------------------------------------------------------------- overview

console.log(`\n${b("1. What is in the database")}`);
const counts = {};
for (const t of ["sessions", "screenshots", "runs", "agent_responses", "verdicts"]) {
  try {
    counts[t] = await q(t, "select=id", { count: true });
    console.log(`  ${g("ok  ")} ${String(counts[t]).padStart(4)}  ${t}`);
  } catch (err) {
    console.log(`  ${r("FAIL")}        ${t} — ${err.message}`);
    counts[t] = null;
  }
}

if (!counts.sessions) {
  console.log(y("\nNothing stored yet. Capture something and press Run, then try again.\n"));
  process.exit(0);
}

// ---------------------------------------------------------------- storage

console.log(`\n${b("2. What is in the bucket")}`);
{
  const res = await fetch(`${base}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 1000, sortBy: { column: "created_at", order: "desc" } }),
  });
  if (!res.ok) {
    console.log(`  ${r("FAIL")} could not list the bucket — ${await res.text()}`);
  } else {
    // Storage lists one level at a time; each session id is a folder.
    const top = await res.json();
    const folders = top.filter((o) => !o.id);
    let objects = 0;
    let bytes = 0;
    for (const f of folders) {
      const sub = await fetch(`${base}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify({ prefix: `${f.name}/`, limit: 1000 }),
      });
      if (!sub.ok) continue;
      for (const o of await sub.json()) {
        if (!o.id) continue;
        objects++;
        bytes += o.metadata?.size ?? 0;
      }
    }
    console.log(
      `  ${g("ok  ")} ${objects} image${objects === 1 ? "" : "s"} across ${folders.length} session folder${folders.length === 1 ? "" : "s"}, ${(bytes / 1048576).toFixed(1)} MB`
    );

    // The check that matters: a row claiming an object should have one.
    const shots = await q("screenshots", "select=id,storage_path,purged_at&limit=1000");
    const missing = shots.filter((s) => !s.storage_path && !s.purged_at).length;
    console.log(
      missing
        ? `  ${y("warn")} ${missing} screenshot row${missing === 1 ? "" : "s"} with no object behind ${missing === 1 ? "it" : "them"}`
        : `  ${g("ok  ")} every screenshot row points at a stored object`
    );
    if (objects < shots.filter((s) => s.storage_path && !s.purged_at).length) {
      console.log(`  ${y("warn")} fewer objects than rows — something was deleted from the bucket directly`);
    }
  }
}

// --------------------------------------------------------------- sessions

const sessions = await q(
  "sessions",
  `select=id,title,status,created_at,updated_at&order=updated_at.desc&limit=${ALL ? 50 : 1}`
);

console.log(`\n${b(ALL ? "3. Sessions" : "3. The most recent session")}`);

for (const s of sessions) {
  const shots = await q("screenshots", `select=id,file_name,bytes,storage_path,position&session_id=eq.${s.id}&order=position`);
  const runs = await q("runs", `select=id,mode,asked,started_at,finished_at,context_mode,extraction_agreed&session_id=eq.${s.id}&order=started_at.desc`);

  console.log(`\n  ${b(s.title || "(untitled)")}   ${dim(s.status)}`);
  console.log(dim(`  ${s.id}`));
  console.log(`  created ${when(s.created_at)} · updated ${when(s.updated_at)}  ${dim("(Nashville)")}`);
  console.log(`  ${shots.length} screenshot${shots.length === 1 ? "" : "s"} · ${runs.length} run${runs.length === 1 ? "" : "s"}`);

  for (const sh of shots) {
    console.log(dim(`    #${sh.position}  ${sh.file_name}  ${(sh.bytes / 1024).toFixed(0)} KB  ${sh.storage_path ? "stored" : r("NO OBJECT")}`));
  }

  if (ALL) continue;

  for (const run of runs) {
    const responses = await q(
      "agent_responses",
      `select=provider,model,status,final_answer,final_code,complexity,confidence,input_tokens,output_tokens,elapsed_ms,error&run_id=eq.${run.id}`
    );
    const [verdict] = await q(
      "verdicts",
      `select=verdict,headline,detail,reliability,judge_provider,judge_text&run_id=eq.${run.id}&limit=1`
    );

    console.log(`\n  ${b("Run")} ${when(run.started_at)} · mode ${run.mode} · context ${run.context_mode}`);
    if (run.asked?.trim()) {
      console.log(`  ${b("You asked")}`);
      console.log(wrap(run.asked));
    } else {
      console.log(dim("  (no typed note — the question was the screenshot)"));
    }

    console.log(`  ${b("Answers")} (${responses.length})`);
    for (const a of responses) {
      const head = `    ${a.provider.padEnd(10)} ${dim(a.model)}`;
      if (a.status !== "done") {
        console.log(`${head}  ${r(a.status)} ${a.error ? dim(`— ${String(a.error).slice(0, 70)}`) : ""}`);
        continue;
      }
      const tok = a.output_tokens != null ? `${a.input_tokens ?? "?"}→${a.output_tokens} tok` : "";
      const secs = a.elapsed_ms != null ? `${(a.elapsed_ms / 1000).toFixed(1)}s` : "";
      console.log(`${head}  ${g("done")}  ${dim([tok, secs, a.complexity, a.confidence != null ? `conf ${a.confidence}` : ""].filter(Boolean).join(" · "))}`);
      if (a.final_answer) console.log(wrap(a.final_answer, 88, "        "));
      if (a.final_code) console.log(dim(`        [${String(a.final_code).split("\n").length} lines of code stored]`));
    }

    if (verdict) {
      console.log(`  ${b("Verdict")}  ${verdict.verdict ?? "—"} · reliability ${verdict.reliability ?? "—"}`);
      if (verdict.headline) console.log(wrap(verdict.headline));
      if (verdict.judge_provider) {
        console.log(`  ${b("Judge")} ${verdict.judge_provider}${verdict.judge_text ? "" : dim(" (no text stored)")}`);
        if (verdict.judge_text) console.log(wrap(verdict.judge_text.split("\n").slice(0, 6).join(" "), 88, "     "));
      }
    } else {
      console.log(`  ${y("warn")} no verdict stored for this run`);
    }
  }
}

console.log(
  `\n${dim(ALL ? "" : "Run with --all to list every session.")}\n`
);
