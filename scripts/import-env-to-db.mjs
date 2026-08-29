#!/usr/bin/env node
/**
 * Move `.development.env` into the database.
 *
 *   node scripts/import-env-to-db.mjs --dry-run   # say what would happen
 *   node scripts/import-env-to-db.mjs             # do it
 *   node scripts/import-env-to-db.mjs --prune     # also delete stored keys the file no longer has
 *   node scripts/import-env-to-db.mjs --list      # what is stored now
 *
 * Four variables are never imported, because they are what opens the database:
 * `DATABASE_URL`, `SUPABASE_URL`, the service-role key and the anon key. Storing
 * them inside the thing they unlock is circular, and pretending otherwise would
 * produce an app that cannot start.
 *
 * No value is ever printed. Secrets are reported by name and by whether they are
 * set; non-secrets by name and length. A config tool whose output you cannot
 * paste into a bug report is a config tool you will stop using.
 */

import { BOOTSTRAP, looksSecret, PROCESS_LOCAL, readEnvFile } from "./lib/config.mjs";

const argv = new Set(process.argv.slice(2));
const DRY = argv.has("--dry-run");
const PRUNE = argv.has("--prune");
const LIST = argv.has("--list");

const URL_ = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const SERVICE = (
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ""
).trim();

if (!URL_ || !SERVICE) {
  console.error("Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .development.env.");
  process.exit(2);
}

const headers = {
  apikey: SERVICE,
  authorization: `Bearer ${SERVICE}`,
  "content-type": "application/json",
};
const table = `${URL_}/rest/v1/app_config`;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const g = (s) => `\x1b[32m${s}\x1b[0m`;

async function stored() {
  const res = await fetch(`${table}?select=key,value,secret,updated_at,owner_id&order=key`, { headers });
  if (!res.ok) {
    if (res.status === 404) {
      console.error(
        "There is no app_config table yet. Start the app once so it applies the\n" +
          "migration, or run supabase/migrations.sql against the project."
      );
      process.exit(1);
    }
    console.error(`Supabase answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

if (LIST) {
  const rows = await stored();
  if (!rows.length) {
    console.log("\nNothing stored yet. Run this without --list to import.\n");
    process.exit(0);
  }
  console.log(`\n${rows.length} value(s) in app_config\n`);
  for (const r of rows) {
    const tier = r.owner_id === "00000000-0000-0000-0000-000000000000" ? dim(" platform") : "";
    const shape = r.secret
      ? r.value
        ? g("set")
        : "empty"
      : dim(`${r.value.length} char(s)`);
    console.log(`  ${r.secret ? "🔒" : "  "} ${r.key.padEnd(42)} ${shape}${tier}`);
  }
  console.log();
  process.exit(0);
}

/**
 * Values this refuses to store, and why.
 *
 * The owner PIN is hashed with Argon2id over a Keychain pepper precisely so that
 * a copy of the database is not a way in. Keeping the plaintext PIN in a table
 * in that same database undoes the entire design — anyone who reads `app_config`
 * can then sign in as the owner. Pass --allow-pin if you want it anyway.
 */
const REFUSED = new Map([
  [
    "CODE_AUDITOR_ADMIN_PIN",
    "the plaintext owner PIN, in the same database as the hash meant to protect it",
  ],
]);
const ALLOW_REFUSED = argv.has("--allow-pin");

const file = readEnvFile();
const skipped = [];
const refused = [];
const rows = [];
for (const [key, value] of file) {
  if (BOOTSTRAP.has(key) || PROCESS_LOCAL.has(key)) {
    skipped.push(key);
    continue;
  }
  if (REFUSED.has(key) && !ALLOW_REFUSED) {
    refused.push(key);
    continue;
  }
  rows.push({ key, value, secret: looksSecret(key) });
}

console.log(`\n${rows.length} variable(s) to store, ${skipped.length} kept local\n`);
for (const key of skipped) {
  console.log(
    dim(
      PROCESS_LOCAL.has(key)
        ? `  local  ${key}  (belongs to the process that starts, not to configuration)`
        : `  app    ${key}  (opens the database — set in Settings, read from the Keychain)`
    )
  );
}
console.log();
for (const r of rows) console.log(`  ${r.secret ? "🔒" : "  "} ${r.key}`);

for (const key of refused) {
  console.log(`\n  ${key} was NOT stored — ${REFUSED.get(key)}.`);
  console.log(dim(`  Delete the line from .development.env, or pass --allow-pin to store it anyway.`));
}

if (DRY) {
  console.log(dim("\n--dry-run: nothing written.\n"));
  process.exit(0);
}

const res = await fetch(table, {
  method: "POST",
  headers: { ...headers, prefer: "resolution=merge-duplicates" },
  body: JSON.stringify(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }))),
});
if (!res.ok) {
  const detail = await res.text();
  if (res.status === 404 || detail.includes("PGRST205")) {
    console.error(
      "\nThere is no app_config table yet, so nothing was written.\n" +
        "Launch the app once — it applies the migration on connect — or paste the\n" +
        "app_config block at the end of supabase/migrations.sql into the Supabase\n" +
        "SQL editor. Then run this again.\n"
    );
    process.exit(1);
  }
  console.error(`\nSupabase answered ${res.status}: ${detail}`);
  process.exit(1);
}

if (PRUNE) {
  const have = new Set(rows.map((r) => r.key));
  const gone = (await stored()).map((r) => r.key).filter((k) => !have.has(k));
  for (const key of gone) {
    const del = await fetch(`${table}?key=eq.${encodeURIComponent(key)}`, { method: "DELETE", headers });
    console.log(del.ok ? `  removed ${key}` : `  could not remove ${key} (${del.status})`);
  }
}

console.log(g(`\n${rows.length} value(s) stored.`));
console.log(
  "\nThe env file is no longer read for anything that matters: configuration comes\n" +
    "from here, and the four bootstrap credentials come from the Keychain, where\n" +
    "Settings already put them. Verify with:\n\n" +
    "  node scripts/where-config-comes-from.mjs\n\n" +
    "Once that shows every source as the app, .development.env can go. Keep a copy\n" +
    "somewhere safe until you have seen the worker run once without it.\n"
);
