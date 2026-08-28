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
check("sixteen tables found", tables.size === 16, [...tables.keys()].join(", "));
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
  "app_users",
  "app_sessions",
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

// ------------------------------------------- 2: the SQL that still exists

console.log("\n2. the SQL functions name only columns the schema has");
//
// Sections 2-4 used to scan Rust for `sqlx::query` calls: placeholders against
// binds, `row.get("col")` against the schema, insert columns against values.
// There is no SQL in Rust any more — it moved into `supabase/migrations.sql` as
// plpgsql functions and into the Edge Function — so those checks were asserting
// facts about an empty set, which is worse than not checking: a green tick for
// work nobody is doing.
//
// What replaces them is the same idea aimed at where the SQL actually went.
{
  const fnBodies = [...schemaSql.matchAll(/create or replace function\s+(\w+)[\s\S]*?\n\$\$;/gi)];
  check("the migration file defines functions", fnBodies.length > 0, `${fnBodies.length}`);

  const known = new Set([...tables.values()].flatMap((cols) => [...cols]));
  for (const fn of fnBodies) {
    const name = fn[1];
    // Columns named in `insert into <table> (a, b, c)` inside each function.
    for (const ins of fn[0].matchAll(/insert into\s+(\w+)\s*\n?\s*\(([^)]*)\)/gi)) {
      const table = ins[1];
      const cols = ins[2].split(",").map((c) => c.trim()).filter(Boolean);
      const schemaCols = tables.get(table);
      if (!schemaCols) {
        check(`${name}: ${table} is a table`, false, "unknown table");
        continue;
      }
      const unknown = cols.filter((c) => !schemaCols.has(c));
      check(`${name}: every column it writes into ${table} exists`, unknown.length === 0, unknown.join(","));
    }
    void known;
  }
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall SQL checks passed\n");
process.exit(fail ? 1 : 0);
