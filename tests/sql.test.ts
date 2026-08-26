import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Static checks on the Rust SQL.
 *
 * The session layer uses `sqlx::query` rather than the `query!` macro, because
 * the macro wants a live DATABASE_URL at compile time and this app is configured
 * by the person using it, not at build time. The cost of that choice is that
 * nothing checks the SQL until it runs: a bind count that does not match the
 * placeholders, or a column that does not exist, compiles perfectly and fails on
 * a real user's first capture.
 *
 * These are the three mistakes that class of bug actually takes, checked against
 * the schema the app ships and applies itself.
 */

const RUST_DIR = "src-tauri/src";
const SQL_FILES = ["supabase/schema.sql", "supabase/migrations.sql"];

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

// ------------------------------------------------------------------ schema

const schemaSql = SQL_FILES.map((f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}).join("\n");

const NOT_A_COLUMN = new Set([
  "primary",
  "unique",
  "foreign",
  "constraint",
  "check",
  "references",
]);

const tables = new Map<string, Set<string>>();

for (const m of schemaSql.matchAll(
  /create table if not exists\s+(\w+)\s*\(([\s\S]*?)\n\);/gi
)) {
  const cols = new Set<string>();
  for (const line of m[2].split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("--")) continue;
    const w = /^([a-z_][a-z0-9_]*)\s/.exec(t);
    if (w && !NOT_A_COLUMN.has(w[1])) cols.add(w[1]);
  }
  tables.set(m[1], cols);
}

// Columns added later live in migrations.sql, not in the create statement.
for (const m of schemaSql.matchAll(
  /alter table if exists\s+(\w+)\s+add column if not exists\s+(\w+)/gi
)) {
  if (!tables.has(m[1])) tables.set(m[1], new Set());
  tables.get(m[1])!.add(m[2]);
}

console.log("\n1. the schema parses");
check("thirteen tables found", tables.size === 13, [...tables.keys()].join(", "));
for (const t of [
  "sessions",
  "screenshots",
  "runs",
  "agent_responses",
  "verdicts",
  "solve_jobs",
  "solve_job_images",
  "solve_job_events",
  "council_reports",
  "notification_devices",
  "settings",
  "intelligence_sources",
  "intelligence_records",
]) {
  check(`${t} present`, tables.has(t));
}
check(
  "the vision-pass columns are in migrations",
  ["context_mode", "extracted_context", "extraction_agreed"].every((c) =>
    tables.get("runs")?.has(c)
  ),
  [...(tables.get("runs") ?? [])].join(",")
);

// -------------------------------------------------------------- rust source

const rust = readdirSync(RUST_DIR)
  .filter((f) => f.endsWith(".rs"))
  .map((f) => ({ file: f, src: readFileSync(join(RUST_DIR, f), "utf8") }));

check("rust sources found", rust.length > 0, String(rust.length));

/** Reads a balanced `(...)` starting at `open`, respecting Rust string literals. */
function balanced(src: string, open: number): { body: string; end: number } {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i };
    }
  }
  return { body: src.slice(open + 1), end: src.length };
}

const lineOf = (src: string, i: number) => src.slice(0, i).split("\n").length;

// ------------------------------------------------ 2: binds vs placeholders

console.log("\n2. every bind has a placeholder and vice versa");
let queries = 0;
let skipped = 0;

for (const { file, src } of rust) {
  for (const m of src.matchAll(/sqlx::query(?:_as)?\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const { body, end } = balanced(src, open);
    const line = lineOf(src, m.index!);

    // `sqlx::query(sql)` where sql is a variable: the SQL is not here to read.
    // Counted and reported rather than silently passed, so the number of
    // unchecked call sites cannot creep up unnoticed.
    if (!body.trim().startsWith('"') && !body.trim().startsWith("r#")) {
      skipped++;
      continue;
    }
    queries++;

    const after = src.slice(end);
    const stop = /\.\s*(execute|fetch_one|fetch_all|fetch_optional)\b/.exec(after);
    const chain = after.slice(0, stop ? stop.index : 1200);
    const binds = [...chain.matchAll(/\.\s*bind\s*\(/g)].length;

    const nums = [...body.matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
    const distinct = [...new Set(nums)].sort((a, b) => a - b);
    const need = distinct.length ? Math.max(...distinct) : 0;

    check(`${file}:${line} ${need} placeholder(s) / ${binds} bind(s)`, binds === need);
    check(
      `${file}:${line} placeholders numbered 1..${need}`,
      distinct.length === need && distinct.every((n, i) => n === i + 1),
      distinct.join(",")
    );
  }
}
console.log(`  (${queries} literal queries checked, ${skipped} built from a variable)`);
check("most queries are literal and therefore checkable", queries > skipped);

// ------------------------------------------------------ 3: column names

console.log("\n3. every column named in Rust exists in the schema");
const knownColumns = new Set<string>();
for (const cols of tables.values()) for (const c of cols) knownColumns.add(c);
// Values computed by a query rather than stored in a table.
for (const c of ["count", "server_version", "table_name", "n"]) knownColumns.add(c);

for (const { file, src } of rust) {
  for (const m of src.matchAll(/\.get(?:::<[^>]+>)?\s*\(\s*"([a-z_][a-z0-9_]*)"\s*\)/g)) {
    check(`${file}:${lineOf(src, m.index!)} row.get("${m[1]}")`, knownColumns.has(m[1]));
  }
}

// ---------------------------------------------------- 4: insert arity

console.log("\n4. inserts name as many columns as they give values");
for (const { file, src } of rust) {
  for (const m of src.matchAll(/insert into\s+(\w+)\s*\(/gi)) {
    const line = lineOf(src, m.index!);
    const colOpen = m.index! + m[0].length - 1;
    const { body: colBody, end: colEnd } = balanced(src, colOpen);
    const rest = src.slice(colEnd);
    const vm = /\bvalues\s*\(/i.exec(rest);
    if (!vm) continue;
    const { body: valBody } = balanced(rest, vm.index + vm[0].length - 1);

    const cols = colBody
      .split(",")
      .map((c) => c.trim().replace(/\s+/g, " "))
      .filter(Boolean);

    // Split on top-level commas only: `coalesce((select ...), 0)` is one value.
    const vals: string[] = [];
    let depth = 0;
    let cur = "";
    for (const c of valBody) {
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (c === "," && depth === 0) {
        vals.push(cur);
        cur = "";
      } else cur += c;
    }
    if (cur.trim()) vals.push(cur);

    check(
      `${file}:${line} insert into ${m[1]}: ${cols.length} columns / ${vals.length} values`,
      cols.length === vals.length
    );

    const known = tables.get(m[1]);
    const unknown = known ? cols.filter((c) => !known.has(c)) : [];
    check(`${file}:${line} all ${m[1]} columns exist`, unknown.length === 0, unknown.join(","));
  }
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall SQL checks passed\n");
process.exit(fail ? 1 : 0);
