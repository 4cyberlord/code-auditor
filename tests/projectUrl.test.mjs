/**
 * The project host, worked out from a Postgres connection string.
 *
 * This used to live in Rust and be tested there. It moved to the Node config
 * loader when the app stopped holding a connection string at all — and the trap
 * it guards moved with it, so the test has to as well: a Postgres password may
 * contain `@`, so the host comes from the *last* one. Splitting on the first is
 * a bug that produces a plausible-looking wrong hostname, which is the kind that
 * survives review.
 */

process.env.CODE_AUDITOR_CONFIG = "off";
const { projectUrl } = await import("../scripts/lib/config.mjs");

let fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

console.log("\n1. both Supabase connection shapes carry the project reference");
check(
  "a direct host",
  projectUrl("postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres") ===
    "https://abcdef.supabase.co"
);
check(
  "a pooler host, where the reference is in the username",
  projectUrl(
    "postgresql://postgres.abcdef:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres"
  ) === "https://abcdef.supabase.co"
);

console.log("\n2. a password containing @ does not become the host");
check(
  "direct",
  projectUrl("postgresql://postgres:p@ss@db.abcdef.supabase.co:5432/postgres") ===
    "https://abcdef.supabase.co",
  String(projectUrl("postgresql://postgres:p@ss@db.abcdef.supabase.co:5432/postgres"))
);
check(
  "pooler",
  projectUrl(
    "postgresql://postgres.abcdef:p@ss@aws-0-eu-west-2.pooler.supabase.com:5432/postgres"
  ) === "https://abcdef.supabase.co"
);

console.log("\n3. anything that is not a Supabase host has no project URL");
for (const conn of [
  "postgresql://u:p@localhost:5432/postgres",
  "postgresql://u:p@db.example.com:5432/postgres",
  // A pooler host with no reference in the username is not enough to guess from.
  "postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
  "",
]) {
  check(`refused: ${conn || "(empty)"}`, projectUrl(conn) === null, String(projectUrl(conn)));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall project URL checks passed\n");
process.exit(fail ? 1 : 0);
