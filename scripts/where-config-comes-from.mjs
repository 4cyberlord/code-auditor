#!/usr/bin/env node
/**
 * Where is each value actually coming from?
 *
 *   node scripts/where-config-comes-from.mjs
 *
 * The point of moving configuration into the database was that a machine should
 * not need a file to be set up. This answers whether that is true *on this
 * machine* — which is not something you can tell by reading the code, because
 * the env file is still there and still silently filling gaps.
 *
 * Values are never printed. Only where each one came from.
 */

import { BOOTSTRAP, projectUrl, readEnvFile } from "./lib/config.mjs";

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const file = readEnvFile();

// config.mjs has already run by this point, so process.env is fully resolved.
// Re-reading with the file removed from the picture tells us who supplied what.
const fromFileOnly = [];
for (const [key] of file) {
  if (BOOTSTRAP.has(key)) continue;
  fromFileOnly.push(key);
}

const conn = process.env.DATABASE_URL || "";
console.log("\nBootstrap — the four that open the database\n");
for (const key of ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]) {
  const have = Boolean((process.env[key] || "").trim());
  const inFile = file.has(key);
  const source = !have ? y("MISSING") : inFile ? y("env file") : g("the app");
  console.log(`  ${key.padEnd(30)} ${source}`);
}
if (conn && !projectUrl(conn)) {
  console.log(dim("\n  (the connection string is not a recognised Supabase host, so"));
  console.log(dim("   SUPABASE_URL could not be derived from it)"));
}

const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
let stored = [];
if (url && service) {
  const res = await fetch(`${url}/rest/v1/app_config?select=key`, {
    headers: { apikey: service, authorization: `Bearer ${service}` },
  });
  if (res.ok) stored = await res.json();
}

console.log(`\nConfiguration — ${stored.length} value(s) in app_config\n`);
const storedKeys = new Set(stored.map((r) => r.key));
const onlyInFile = fromFileOnly.filter((k) => !storedKeys.has(k));

if (!stored.length) {
  console.log(y("  nothing stored yet — run npm run config:import"));
} else if (onlyInFile.length) {
  console.log(y(`  ${onlyInFile.length} value(s) exist only in the env file:\n`));
  for (const k of onlyInFile) console.log(`    ${k}`);
  console.log(dim("\n  Re-run npm run config:import to store them."));
} else {
  console.log(g("  every value in the env file is also in the database"));
}

console.log(
  onlyInFile.length || !stored.length
    ? "\n" + y("Not yet safe to delete .development.env.") + "\n"
    : "\n" + g("Safe to delete .development.env — nothing here needs it.") + "\n"
);
