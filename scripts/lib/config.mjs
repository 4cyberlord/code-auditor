/**
 * Configuration comes from the database, not from a file on this machine.
 *
 * Import this first, before anything reads `process.env`:
 *
 *     import "./lib/config.mjs";
 *
 * It has a top-level await, so the fetch completes before the importing
 * module's body runs. Every script then keeps reading `process.env.WHATEVER`
 * exactly as it always did — this changes where the values come from, not how
 * they are used.
 *
 * ## What still has to be local
 *
 * Four values cannot live in the database, because they are what opens it:
 * `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and the anon key.
 * Storing them inside the thing they unlock is circular. They stay in
 * `.development.env`, and that file should now contain little else.
 *
 * ## Precedence
 *
 * Anything already set in the real environment wins. The database fills gaps; it
 * does not overrule a value someone exported on purpose for one run. That is
 * what keeps `CODE_AUDITOR_BATCH_EXECUTION=local npm run …` working.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Where the app keeps the two credentials you set in Settings. */
const KEYCHAIN_SERVICES = ["com.charles.councileditor", "com.charles.codeauditor"];
const KC_CONNECTION = "supabase-url";
const KC_SERVICE_ROLE = "supabase_storage";

/**
 * Read one Keychain entry, without ever putting it on a command line that `ps`
 * could show. Returns null rather than throwing: an entry that is not there is
 * the ordinary state, not an error.
 *
 * macOS only. On anything else this returns null and the env file is the only
 * source, which is correct — the Keychain is where *this* app puts things.
 */
function keychain(account) {
  if (process.platform !== "darwin") return null;
  for (const service of KEYCHAIN_SERVICES) {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (out) return out;
    } catch {
      /* not in this keychain — try the next service name */
    }
  }
  return null;
}

/**
 * The project host, worked out from the connection string.
 *
 * The same rule as `storage.rs`, including the trap it fell into once: the
 * password may contain an `@`, so the host comes from the *last* one.
 *
 *   direct: postgresql://postgres:pw@db.<ref>.supabase.co:5432/postgres
 *   pooler: postgresql://postgres.<ref>:pw@aws-0-x.pooler.supabase.com:5432/postgres
 */
export function projectUrl(conn) {
  if (!conn) return null;
  const afterAt = conn.split("@").pop() ?? "";
  const host = afterAt.split(/[/:]/)[0] ?? "";

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

/** The four that cannot be stored in the database they open. */
export const BOOTSTRAP = new Set([
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
]);

/**
 * A name that looks like it holds a secret. Used when importing, not when reading.
 *
 * Case-insensitive, because it has to be: `council_editor_api_access_token` is a
 * Supabase access token and an uppercase-only pattern waved it through. Erring
 * toward flagging is free — a mislabelled non-secret costs nothing, and a
 * missed secret is one that gets shown in a list.
 */
export function looksSecret(name) {
  return /(_KEY|_TOKEN|_SECRET|_PIN|_PASSWORD|_DSN|PRIVATE_KEY|_CREDENTIALS|_ACCESS_TOKEN)$/i.test(
    name
  );
}

export function readEnvFile(dir = process.cwd()) {
  const found = new Map();
  for (const file of [".development.env", ".env"]) {
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    for (const raw of readFileSync(full, "utf8").split(/\r?\n/)) {
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!found.has(m[1])) found.set(m[1], v);
    }
  }
  return found;
}

/** Fill `process.env` from a file, without overriding what is already set. */
function applyFile() {
  for (const [k, v] of readEnvFile()) {
    if (!process.env[k]) process.env[k] = v;
  }
}

/**
 * The bootstrap credentials, from where the app already keeps them.
 *
 * These are the four that cannot live in the database, because they are what
 * opens it. That does not mean they belong in a file: the app has always read
 * them from the Keychain, written there by Settings, and `.development.env` was
 * a second copy that nothing but these scripts ever used. This reads the app's
 * copy, so there is one place to set them and it is the Settings dialog.
 *
 * Order: anything already exported wins, then the Keychain, then the env file
 * for a machine that has not run the app yet.
 */
function applyKeychain() {
  const conn = keychain(KC_CONNECTION);
  if (conn) {
    if (!process.env.DATABASE_URL) process.env.DATABASE_URL = conn;
    const base = projectUrl(conn);
    if (base && !process.env.SUPABASE_URL) process.env.SUPABASE_URL = base;
  }

  const service = keychain(KC_SERVICE_ROLE);
  if (service && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    process.env.SUPABASE_SERVICE_ROLE_KEY = service;
  }
}

/**
 * The publishable key, from the `settings` row the app already reads.
 *
 * Last of the four, and the only one that was never in the Keychain — it is not
 * a secret, so it lives in the database like the rest of the configuration.
 */
async function applyPublishableKey() {
  if (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY) return;
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const service = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !service) return;
  try {
    // Platform row first — `settings` is keyed on (owner_id, key) now, so asking
    // by key alone can return several and picking [0] would be a coin toss.
    const res = await fetch(
      `${url}/rest/v1/settings?key=eq.serverApi&select=value,owner_id&order=owner_id.asc`,
      { headers: { apikey: service, authorization: `Bearer ${service}` } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const platform = rows.find((r) => r.owner_id === "00000000-0000-0000-0000-000000000000");
    const key = (platform ?? rows[0])?.value?.publishableKey;
    if (key) process.env.SUPABASE_ANON_KEY = key;
  } catch {
    /* offline is not fatal — only this one value is missing */
  }
}

/** Every row of `app_config`, as `{ key, value, secret }`. Needs the service role. */
export async function fetchConfig() {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const service = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "").trim();
  if (!url || !service) return null;

  // Ordered so the platform tier lands first and personal rows overwrite it —
  // the same "your own wins" rule the app applies.
  //
  // Note for phase 03b: this fills one process-wide environment, which is right
  // for worker settings (poll interval, worker id, rosters) and wrong for
  // provider keys once several accounts have their own. The worker will need to
  // resolve keys per job from the job's owner rather than from process.env.
  const res = await fetch(
    `${url}/rest/v1/app_config?select=key,value,secret,owner_id&order=owner_id.asc`,
    { headers: { apikey: service, authorization: `Bearer ${service}` } }
  );
  if (!res.ok) {
    // A missing table is the ordinary state before the first import, not a
    // failure worth stopping a worker over.
    if (res.status === 404 || res.status === 406) return null;
    throw new Error(`Could not read app_config: ${res.status}`);
  }
  return res.json();
}

let loaded = null;

/**
 * `CODE_AUDITOR_CONFIG=off` disables this entirely — no file, no fetch.
 *
 * For tests, which have to be hermetic. A test that sets its own environment and
 * then silently inherits a developer's `.development.env` is a test that passes
 * or fails depending on whose machine it runs on.
 */
const DISABLED = process.env.CODE_AUDITOR_CONFIG === "off";

/** Idempotent: the second import of this module does not fetch again. */
export async function loadConfig({ quiet = true } = {}) {
  if (loaded) return loaded;
  if (DISABLED) {
    loaded = { filled: 0, found: 0, fromDatabase: false, disabled: true };
    return loaded;
  }
  // Keychain first: it is what the app itself reads, so it is the one that is
  // definitely current. The file only fills what the Keychain did not have.
  applyKeychain();
  applyFile();
  await applyPublishableKey();

  let rows = null;
  try {
    rows = await fetchConfig();
  } catch (err) {
    if (!quiet) console.warn(`[config] ${err.message} — falling back to the env file alone.`);
  }

  let filled = 0;
  for (const row of rows ?? []) {
    if (BOOTSTRAP.has(row.key)) continue;
    if (process.env[row.key]) continue;
    process.env[row.key] = row.value ?? "";
    filled++;
  }

  loaded = { filled, found: rows?.length ?? 0, fromDatabase: rows !== null };
  if (!quiet) {
    console.log(
      rows === null
        ? "[config] database not reachable — using the env file"
        : `[config] ${filled} value(s) from the database, ${rows.length} stored`
    );
  }
  return loaded;
}

await loadConfig();
