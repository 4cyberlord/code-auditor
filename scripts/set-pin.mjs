#!/usr/bin/env node
/**
 * Set an account's PIN to the server-side scheme.
 *
 *   COUNCIL_EDITOR_PIN_PEPPER='...' node scripts/set-pin.mjs <username> <4-digit pin>
 *
 * Accounts created before sign-in moved to the server hold an Argon2id hash that
 * the server cannot verify, and the desktop no longer carries the pepper needed
 * to verify it locally. This re-hashes with bcrypt and the server's pepper, which
 * is the one step between an old account and being able to sign in at all.
 *
 * Run it once per existing account. New accounts never need it.
 *
 * The PIN is not echoed.
 */

import "./lib/config.mjs";

const [username, pin] = process.argv.slice(2);
const URL_ = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const SERVICE = (
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ""
).trim();
const PEPPER = (process.env.COUNCIL_EDITOR_PIN_PEPPER || "").trim();

if (!username || !/^[0-9]{4}$/.test(pin ?? "")) {
  console.error("Usage: COUNCIL_EDITOR_PIN_PEPPER='...' node scripts/set-pin.mjs <username> <4-digit pin>");
  process.exit(2);
}
if (!URL_ || !SERVICE) {
  console.error("Need SUPABASE_URL and the service role key.");
  process.exit(2);
}
if (!PEPPER) {
  console.error(
    "Need COUNCIL_EDITOR_PIN_PEPPER — the same value you gave `supabase secrets set`.\n" +
      "A PIN hashed with the wrong pepper will be refused by the server, and it will\n" +
      "look exactly like a wrong PIN."
  );
  process.exit(2);
}

const headers = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" };

const found = await fetch(
  `${URL_}/rest/v1/app_users?username=eq.${encodeURIComponent(username)}&select=id,username`,
  { headers }
);
const user = (await found.json())?.[0];
if (!user) {
  console.error(`No account called "${username}".`);
  process.exit(1);
}

const res = await fetch(`${URL_}/rest/v1/rpc/auth_set_pin`, {
  method: "POST",
  headers,
  body: JSON.stringify({ p_user_id: user.id, p_pin: pin, p_pepper: PEPPER }),
});
if (!res.ok) {
  console.error(`Could not set the PIN: ${res.status} ${await res.text()}`);
  process.exit(1);
}

console.log(`\n\x1b[32mPIN set for ${user.username}.\x1b[0m It is now verified by the server, not this Mac.\n`);
