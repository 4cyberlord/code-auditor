#!/usr/bin/env node
/**
 * Turn the server read path on or off, by writing one row of `settings`.
 *
 *   node scripts/enable-server-api.mjs        # on
 *   node scripts/enable-server-api.mjs --off  # back to reading Postgres directly
 *
 * There is exactly one setting: the project's publishable key. The function URL
 * is not stored — the app works it out from the project reference it already
 * has, so there is nothing to keep in step by hand.
 *
 * Nothing here belongs in the Keychain. A publishable key is meant to ship
 * inside clients; it says a request reached the right project and nothing about
 * who sent it. The Keychain is for values that would be dangerous in a backup,
 * and spending that on this one would make the machine harder to reproduce for
 * no protection at all.
 *
 * The key is never printed — only whether it was found.
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const OFF = process.argv.includes("--off");
const URL_ = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const SERVICE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const PUBLISHABLE = (
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ""
).trim();

if (!URL_ || !SERVICE) {
  console.error("Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .development.env.");
  process.exit(2);
}
if (!OFF && !PUBLISHABLE) {
  console.error("Need SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) in .development.env.");
  process.exit(2);
}

const headers = {
  apikey: SERVICE,
  authorization: `Bearer ${SERVICE}`,
  "content-type": "application/json",
};

const endpoint = `${URL_}/rest/v1/settings`;

const res = OFF
  ? await fetch(`${endpoint}?key=eq.serverApi`, { method: "DELETE", headers })
  : await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        // The all-zeroes owner is the platform tier: the same endpoint for every
        // account, rather than a copy per person that could drift apart.
        owner_id: "00000000-0000-0000-0000-000000000000",
        key: "serverApi",
        value: { publishableKey: PUBLISHABLE },
        updated_at: new Date().toISOString(),
      }),
    });

if (!res.ok) {
  console.error(`Supabase answered ${res.status}: ${await res.text()}`);
  process.exit(1);
}

console.log(
  OFF
    ? "\nServer read path off. The app reads Postgres directly again on its next settings write or restart.\n"
    : "\nServer read path on. History and signed screenshot URLs now go through the Edge Function.\n" +
      "Restart the app (or save any setting) to pick it up.\n"
);
