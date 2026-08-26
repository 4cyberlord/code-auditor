#!/usr/bin/env node
/**
 * Does the picture actually reach the database, and come back?
 *
 *   npm run test:storage
 *
 * This walks the exact path the app walks — same Keychain entries, same project
 * URL derivation, same bucket, same headers — so a pass here means the app will
 * work, and a failure names the step rather than the symptom.
 *
 * It is deliberately end-to-end rather than a credential check. "The key is
 * valid" and "a screenshot I took can be opened again on another device" are
 * different claims, and only the second one is the promise. So it uploads a real
 * image, signs a URL, fetches it back, compares it byte for byte, and then
 * deletes what it made. Nothing is left behind in the bucket.
 *
 * No secret is ever printed. Keys appear masked, and only enough to tell two
 * apart.
 */

import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";

const SERVICE = "com.charles.codeauditor";
const STORAGE_ACCOUNT = "supabase_storage";
const DB_ACCOUNT = "supabase-url";
const BUCKET = "screenshots";

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failed = 0;
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? g("ok  ") : r("FAIL")} ${name}${cond || !extra ? "" : "  " + extra}`);
  if (!cond) failed++;
  return cond;
};

const die = (msg, hint = "") => {
  console.error(`\n${r(msg)}`);
  if (hint) console.error(hint);
  console.error("");
  process.exit(1);
};

function keychain(account) {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    return "";
  }
}

const mask = (k) => (k.length <= 12 ? "•".repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`);

/**
 * The project URL, from the connection string. A port of `project_url` in
 * src-tauri/src/storage.rs — if this and the app ever disagree, that is the bug.
 * The password may contain `@`, so the host comes from the LAST one.
 */
function projectUrl(conn) {
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

function diagnose(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const low = text.toLowerCase();
  if (status === 401 || low.includes("invalid jwt") || low.includes("invalid api key")) {
    return "That key was rejected. It must be the project's service_role key — the anon key cannot write to a private bucket. Project Settings → API.";
  }
  if (status === 403 || low.includes("row-level security")) {
    return "Refused. A service_role key bypasses row-level security; an anon key does not, which is usually what this means.";
  }
  if (status === 413 || low.includes("payload too large")) {
    return "Larger than the project's upload limit. Raise it under Storage → Settings.";
  }
  if (status === 404) return "Not found — the bucket or object does not exist.";
  return `HTTP ${status}: ${text.slice(0, 200)}`;
}

// ------------------------------------------------------------------- creds

console.log("\n1. credentials");

const key = process.env.SUPABASE_SERVICE_KEY?.trim() || keychain(STORAGE_ACCOUNT);
if (!ok("service_role key found", Boolean(key))) {
  die(
    "No Supabase Storage key saved.",
    `Save it in the app: Settings → Sessions → Supabase Storage.\n` +
      dim(`Or: SUPABASE_SERVICE_KEY=… npm run test:storage`)
  );
}
console.log(dim(`       ${mask(key)}`));

// A service_role JWT carries its role in the payload, so the commonest mistake
// — pasting the anon key — is catchable here rather than as a 401 later.
let role = "";
try {
  role = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role ?? "";
} catch {
  /* not a JWT; let the server be the judge */
}
if (role) {
  ok(`it is the ${role} key`, role === "service_role", `"${role}" cannot write to a private bucket`);
}

const conn = keychain(DB_ACCOUNT);
if (!ok("database connection string found", Boolean(conn))) {
  die("No database configured.", "Settings → Sessions → add the connection string first.");
}

const base = projectUrl(conn);
if (!ok("project URL derived from it", Boolean(base), "the host is not a Supabase one")) {
  die("Could not work out the project URL.", "Expected a host ending .supabase.co or .pooler.supabase.com");
}
console.log(dim(`       ${base}`));

// ------------------------------------------------------------------ bucket

const H = { Authorization: `Bearer ${key}`, apikey: key };

console.log("\n2. the bucket");
{
  const res = await fetch(`${base}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  const body = await res.text();
  const existed = res.status === 409 || body.includes("already exists");
  if (!ok(existed ? `"${BUCKET}" already exists` : `"${BUCKET}" created`, res.ok || existed, diagnose(res.status, body))) {
    die("Cannot reach or create the bucket.", diagnose(res.status, body));
  }
}

// ------------------------------------------------------------ round trip

// A tiny PNG with known bytes. Small on purpose: this is a plumbing test, and a
// two-megabyte upload would only make a failure slower to discover.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR42mO4IydHFcQwatCoQaMGjRo0atCoQQNvEAD4u3YfaWxGoAAAAABJRU5ErkJggg==",
  "base64"
);
const digest = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const path = `selftest/${randomUUID()}.png`;

console.log("\n3. upload, read back, delete");
let uploaded = false;
try {
  const started = Date.now();
  const put = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...H, "Content-Type": "image/png", "x-upsert": "true" },
    body: PNG,
  });
  const putBody = await put.text();
  if (!ok(`uploaded ${PNG.length} bytes in ${Date.now() - started}ms`, put.ok, diagnose(put.status, putBody))) {
    die("The upload failed.", diagnose(put.status, putBody));
  }
  uploaded = true;

  const sign = await fetch(`${base}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  const signBody = await sign.json().catch(() => ({}));
  const signed = signBody.signedURL ?? "";
  ok("signed a URL for it", Boolean(signed), diagnose(sign.status, signBody));

  if (signed) {
    const url = signed.startsWith("http") ? signed : `${base}/storage/v1${signed}`;
    const got = await fetch(url);
    const back = Buffer.from(await got.arrayBuffer());
    ok("fetched it back", got.ok, `HTTP ${got.status}`);
    // The claim is not "a file exists" — it is "the picture I took is the
    // picture that comes back". Bytes, not size.
    ok(
      `bytes match (${digest(PNG)})`,
      back.length === PNG.length && back.equals(PNG),
      `got ${back.length} bytes, ${digest(back)}`
    );
  }
} finally {
  if (uploaded) {
    const del = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
      method: "DELETE",
      headers: H,
    });
    ok("cleaned up after itself", del.ok || del.status === 404, `HTTP ${del.status}`);
  }
}

console.log(
  failed
    ? r(`\n${failed} check(s) failed — see above.\n`)
    : g("\nStorage is working. A screenshot taken here can be opened anywhere.\n")
);
process.exit(failed ? 1 : 0);
