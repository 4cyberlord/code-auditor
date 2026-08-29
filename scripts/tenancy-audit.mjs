#!/usr/bin/env node
/**
 * Does every row have an owner yet?
 *
 *   npm run tenancy:audit
 *
 * Phase 01 of the tenancy migration adds `owner_id` nullable and backfills it on
 * every launch. This answers the only question that matters before making the
 * column mandatory: is there anything left without an owner?
 *
 * Making it mandatory lives in `supabase/tenancy-constrain.sql`, run by hand,
 * because `ensure_schema` replays `migrations.sql` at startup — a `set not null`
 * that fails there stops the app from opening, not just from migrating. This
 * script is the gate in front of that.
 *
 * No row contents are printed, only counts.
 */

import "./lib/config.mjs";

const URL_ = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const SERVICE = (
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ""
).trim();

if (!URL_ || !SERVICE) {
  console.error("Need SUPABASE_URL and the service role key (Settings, or .development.env).");
  process.exit(2);
}

/** Tables that carry their own owner_id in phase 01. */
const TABLES = [
  "sessions",
  "screenshots",
  "runs",
  "solve_jobs",
  "solve_job_images",
  "solve_job_events",
  "council_reports",
  "notification_devices",
];

/** Reached through their parent instead, so they have nothing to audit. */
const DERIVED = ["agent_responses", "verdicts"];

/**
 * Key/value tables. Done in phase 03, but differently: their primary key is
 * (owner_id, key) with an all-zeroes owner meaning "platform", so there is no
 * such thing as an unowned row to audit.
 */
const DEFERRED = ["settings", "app_config"];

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const headers = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, prefer: "count=exact" };

/** Postgrest reports the total in content-range as `0-24/1234`. */
async function count(table, query = "") {
  const res = await fetch(`${URL_}/rest/v1/${table}?select=id&limit=1${query}`, { headers });
  if (!res.ok) return { error: res.status, detail: await res.text() };
  const range = res.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return { total: Number.isFinite(total) ? total : 0 };
}

console.log(`\nTenancy audit · ${URL_.replace(/^https:\/\//, "")}\n`);

let unowned = 0;
let orphaned = 0;
let missingColumn = 0;

// The accounts that exist, to compare owner_id against.
const accountRows = await fetch(`${URL_}/rest/v1/app_users?select=id`, { headers });
const accounts = new Set(
  accountRows.ok ? (await accountRows.json()).map((r2) => r2.id) : []
);

for (const table of TABLES) {
  const all = await count(table);
  if (all.error) {
    console.log(`  ${r("?")} ${table.padEnd(24)} ${r(`could not read (${all.error})`)}`);
    missingColumn++;
    continue;
  }

  // Two ways a row can be unowned, and this script only checked one of them.
  // A null owner is the obvious case; an owner_id pointing at an account that
  // no longer exists is the one that actually blocked the constraint, because
  // "every row has an owner" was true and the foreign key still refused.
  const nulls = await count(table, "&owner_id=is.null");
  if (nulls.error) {
    // A 400 here means the column is not there yet — the migration has not run.
    console.log(`  ${y("!")} ${table.padEnd(24)} ${y("no owner_id column yet")}`);
    missingColumn++;
    continue;
  }

  // Postgrest cannot express "not in another table", so the owners are compared
  // here: every distinct owner_id on the table, against the accounts that exist.
  const owners = await fetch(
    `${URL_}/rest/v1/${table}?select=owner_id&owner_id=not.is.null`,
    { headers }
  );
  const seen = owners.ok
    ? new Set((await owners.json()).map((r2) => r2.owner_id).filter(Boolean))
    : new Set();
  const dangling = [...seen].filter((id) => !accounts.has(id));

  const ok = nulls.total === 0 && dangling.length === 0;
  unowned += nulls.total;
  orphaned += dangling.length;
  const shape = ok
    ? g(`all ${all.total} owned`)
    : nulls.total
      ? r(`${nulls.total} of ${all.total} unowned`)
      : r(`${dangling.length} owner(s) that no longer exist`);
  console.log(`  ${ok ? g("ok") : r("!!")} ${table.padEnd(24)} ${shape}`);
}

console.log(dim(`\n  ${DERIVED.join(", ")} — owned through their parent, nothing to check`));
console.log(dim(`  ${DEFERRED.join(", ")} — keyed on (owner_id, key); platform rows own the nil uuid\n`));

if (missingColumn) {
  console.log(
    y("The migration has not run yet.") +
      "\nLaunch the app once — it applies migrations.sql on connect — then run this again.\n"
  );
  process.exit(1);
}

if (orphaned) {
  console.log(
    r(`${orphaned} owner id(s) point at accounts that no longer exist.`) +
      "\nThat is what makes tenancy-constrain.sql fail: the rows have an owner,\n" +
      "the owner is not there. Run supabase/tenancy-orphans.sql first.\n"
  );
  process.exit(1);
}

if (unowned) {
  console.log(
    r(`${unowned} row(s) still have no owner.`) +
      "\nThat means a row whose parent was deleted, or an account created after the rows.\n" +
      "Do NOT run tenancy-constrain.sql yet — inspect those rows first.\n"
  );
  process.exit(1);
}

console.log(
  g("Every row has an owner.") +
    "\nSafe to run supabase/tenancy-constrain.sql in the Supabase SQL editor,\n" +
    "which makes owner_id mandatory and cascades account deletion.\n"
);
