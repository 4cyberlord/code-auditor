#!/usr/bin/env node
/**
 * Does server-side sign-in actually work, and refuse what it should?
 *
 *   npm run test:auth
 *
 * Everything here runs against a throwaway account, never yours. That is not
 * politeness: proving the lockout works means sending five wrong PINs, and
 * sending those to your own account would lock you out of your own app for an
 * hour to satisfy a test.
 *
 * No PIN or token is ever printed.
 */

import { createHash, randomBytes } from "node:crypto";
import "./lib/config.mjs";

const API = (process.env.COUNCIL_EDITOR_API_URL || "").trim();
const KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
const URL_ = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const SERVICE = (
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ""
).trim();

if (!API || !KEY || !URL_ || !SERVICE) {
  console.error("Need COUNCIL_EDITOR_API_URL, the publishable key, SUPABASE_URL and the service role key.");
  process.exit(2);
}

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? g("ok  ") : r("FAIL")} ${name}${cond ? "" : `  ${extra}`}`);
  if (!cond) failed++;
};

const svc = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" };

async function db(path, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...svc, ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function rpc(fn, args) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: svc,
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function call(op, args = {}, token = null) {
  const headers = { "content-type": "application/json", apikey: KEY };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API, { method: "POST", headers, body: JSON.stringify({ op, args }) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON reply is itself a finding */
  }
  return { status: res.status, body };
}

const NAME = "auth-probe";
const PIN = "8261";
const NEXT_PIN = "5074";
const PEPPER = (process.env.COUNCIL_EDITOR_PIN_PEPPER || "").trim();
let probeId = null;

async function cleanup() {
  try {
    if (probeId) await db(`app_users?id=eq.${probeId}`, { method: "DELETE" });
  } catch (err) {
    console.error(r(`\nCleanup failed: ${err.message}\nRemove the auth-probe account by hand.\n`));
  }
}

try {
  console.log(`\nSign-in proof · ${URL_.replace(/^https:\/\//, "")}\n`);

  await db(`app_users?username=eq.${NAME}`, { method: "DELETE" }).catch(() => {});
  // Deliberately an Argon2id-shaped hash, so the first assertion is the real
  // migration case: an account whose PIN predates server-side checking.
  const made = await db("app_users", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ username: NAME, pin_hash: "$argon2id$v=19$m=19456,t=2,p=1$notarealhash" }),
  });
  probeId = made[0].id;
  console.log(dim(`  probe account: ${NAME}\n`));

  // The functions live in migrations.sql, which the app applies on connect. A
  // raw "PGRST202 could not find the function" is a true message that answers
  // the wrong question, so ask first and say what to do.
  const probeRpc = await fetch(`${URL_}/rest/v1/rpc/auth_verify_pin`, {
    method: "POST",
    headers: svc,
    body: JSON.stringify({ p_username: "", p_pin: "", p_pepper: "" }),
  });
  if (probeRpc.status === 404) {
    console.log(
      r("  The sign-in functions are not in the database yet.\n") +
        "\n  Paste supabase/auth-functions.sql into the Supabase SQL editor, or\n" +
        "  launch the app once — it applies migrations.sql on connect.\n"
    );
    await cleanup();
    process.exit(1);
  }

  console.log("1. an old local hash is told to reset, not called wrong");
  const stale = await call("auth.login", { username: NAME, pin: PIN });
  check("an Argon2id account gets 409, not 401", stale.status === 409, `got ${stale.status}`);
  check(
    "and is not charged a failed attempt",
    (await db(`app_users?id=eq.${probeId}&select=failed_attempts`))[0].failed_attempts === 0,
    "an account that cannot be verified must not be locked out by trying"
  );

  if (!PEPPER) {
    // Not a failure: the pepper is a server secret and this machine is not
    // supposed to keep a copy. But saying "skipped" without saying how to
    // un-skip it is how a suite quietly shrinks to the part that always runs.
    console.log(
      dim("\n  Only section 1 ran. Sections 2-6 set a PIN, which needs the same pepper\n") +
        dim("  the deployed function holds, and that is not stored on this machine.\n\n") +
        "  COUNCIL_EDITOR_PIN_PEPPER='<your pepper>' npm run test:auth\n"
    );
  } else {
    await rpc("auth_set_pin", { p_user_id: probeId, p_pin: PIN, p_pepper: PEPPER });

    console.log("\n2. wrong answers are refused, and all look the same");
    const wrongPin = await call("auth.login", { username: NAME, pin: "0000" });
    const noSuchUser = await call("auth.login", { username: "nobody-at-all", pin: PIN });
    check("a wrong PIN is 401", wrongPin.status === 401, `got ${wrongPin.status}`);
    check("an unknown username is 401", noSuchUser.status === 401, `got ${noSuchUser.status}`);
    check(
      "and they are word-for-word identical",
      wrongPin.body?.error === noSuchUser.body?.error,
      "a different answer for a real username tells an attacker which to guess"
    );
    const malformed = await call("auth.login", { username: NAME, pin: "12" });
    check("a malformed PIN is refused the same way", malformed.body?.error === wrongPin.body?.error,
      JSON.stringify(malformed.body?.error));

    console.log("\n3. the right answer signs in");
    await rpc("auth_set_pin", { p_user_id: probeId, p_pin: PIN, p_pepper: PEPPER });
    const good = await call("auth.login", { username: NAME, pin: PIN });
    check("a correct PIN returns a token", good.status === 200 && Boolean(good.body?.data?.token),
      JSON.stringify(good.body?.error));

    if (good.status !== 200) {
      // Everything below assumes a working sign-in, and without one the
      // assertions pass for the wrong reason: "the lockout refuses the correct
      // PIN" is trivially true when no PIN works at all, and "the old PIN no
      // longer works" is true when none of them ever did. Greens earned that way
      // are worse than failures, so stop rather than print them.
      if (good.status === 401) {
        console.log(
          r("\n  The PIN this test set is not the PIN the server sees.\n") +
            "  COUNCIL_EDITOR_PIN_PEPPER here does not match the secret the deployed\n" +
            "  function holds — every remaining section would only re-prove that.\n"
        );
      }
      console.log(dim("  Sections 4-6 not run.\n"));
      await cleanup();
      console.log(r(`\n${failed} failure(s)\n`));
      process.exit(1);
    }
    check("it names the account", good.body?.data?.username === NAME, String(good.body?.data?.username));
    check("and the session expires", Boolean(good.body?.data?.expiresAt), "no expiry on the session");

    const token = good.body?.data?.token;
    const who = await call("auth.whoami", {}, token);
    check("the token is accepted", who.body?.data?.username === NAME, JSON.stringify(who.body));

    console.log("\n4. the lockout is enforced by the server");
    for (let i = 0; i < 5; i++) await call("auth.login", { username: NAME, pin: "0000" });
    const locked = await call("auth.login", { username: NAME, pin: PIN });
    check("five wrong PINs lock the account", locked.status === 423, `got ${locked.status}`);
    check(
      "even the correct PIN is refused while locked",
      locked.status === 423,
      "a lockout that the right PIN walks through is not a lockout"
    );
    await rpc("auth_set_pin", { p_user_id: probeId, p_pin: PIN, p_pepper: PEPPER });

    console.log("\n5. signing out ends the session");
    const fresh = (await call("auth.login", { username: NAME, pin: PIN })).body?.data?.token;
    check("signed in again after the reset", Boolean(fresh), "could not sign back in");
    const out = await call("auth.logout", {}, fresh);
    check("logout succeeds", out.status === 200, `got ${out.status}`);
    const afterOut = await call("auth.whoami", {}, fresh);
    check("the token stops working", afterOut.status === 401, `got ${afterOut.status}`);

    console.log("\n6. changing the PIN needs the current one");
    const live = (await call("auth.login", { username: NAME, pin: PIN })).body?.data?.token;
    const other = (await call("auth.login", { username: NAME, pin: PIN })).body?.data?.token;

    const guessed = await call("auth.changePin", { currentPin: "0000", nextPin: NEXT_PIN }, live);
    check("a wrong current PIN is refused", guessed.status === 401, `got ${guessed.status}`);
    const same = await call("auth.changePin", { currentPin: PIN, nextPin: PIN }, live);
    check("reusing the same PIN is refused", same.status === 400, `got ${same.status}`);

    await rpc("auth_set_pin", { p_user_id: probeId, p_pin: PIN, p_pepper: PEPPER });
    const changed = await call("auth.changePin", { currentPin: PIN, nextPin: NEXT_PIN }, live);
    check("the right current PIN changes it", changed.status === 200, JSON.stringify(changed.body?.error));

    const old = await call("auth.login", { username: NAME, pin: PIN });
    check("the old PIN no longer works", old.status === 401, `got ${old.status}`);
    const neu = await call("auth.login", { username: NAME, pin: NEXT_PIN });
    check("the new PIN does", neu.status === 200, `got ${neu.status}`);

    const otherAfter = await call("auth.whoami", {}, other);
    check("other sessions were revoked by the change", otherAfter.status === 401, `got ${otherAfter.status}`);
    const liveAfter = await call("auth.whoami", {}, live);
    check("the session that changed it survives", liveAfter.status === 200, `got ${liveAfter.status}`);

    console.log("\n7. an account on the old hash can still be rescued");
    // The migration case end to end: an Argon2id hash the server cannot verify,
    // a session the desktop minted after checking it locally, and a PIN change
    // that has to succeed on the strength of that session alone. If this fails,
    // every existing account is permanently stuck on a PIN it cannot change.
    await db(`app_users?id=eq.${probeId}`, {
      method: "PATCH",
      body: JSON.stringify({ pin_hash: "$argon2id$v=19$m=19456,t=2,p=1$stillnotreal" }),
    });
    const stranded = await call("auth.login", { username: NAME, pin: NEXT_PIN });
    check("the account is refused with 409", stranded.status === 409, `got ${stranded.status}`);

    // Stand in for what the desktop does after verifying the old hash itself.
    const rescueToken = randomBytes(32).toString("hex");
    await db("app_sessions", {
      method: "POST",
      body: JSON.stringify({
        user_id: probeId,
        token_hash: createHash("sha256").update(rescueToken).digest("hex"),
        label: "rescue",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      }),
    });
    const rescued = await call(
      "auth.changePin",
      { currentPin: NEXT_PIN, nextPin: PIN },
      rescueToken
    );
    check("the PIN change is allowed on the session alone", rescued.status === 200,
      JSON.stringify(rescued.body?.error));
    const afterRescue = await call("auth.login", { username: NAME, pin: PIN });
    check("and the account signs in normally afterwards", afterRescue.status === 200,
      `got ${afterRescue.status}`);

  }
} catch (err) {
  console.error(r(`\n${err.message}\n`));
  failed++;
} finally {
  await cleanup();
}

console.log(failed ? r(`\n${failed} failure(s)\n`) : g("\nsign-in holds\n"));
process.exit(failed ? 1 : 0);
