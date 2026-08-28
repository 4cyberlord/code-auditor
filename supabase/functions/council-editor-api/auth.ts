/**
 * Who is calling.
 *
 * The desktop already had a sign-in scheme before this function existed: a PIN
 * checked against `app_users`, and a long-lived token whose SHA-256 lives in
 * `app_sessions` while the token itself sits in the Mac's Keychain. Rather than
 * invent a second identity system, this verifies exactly the same way the Rust
 * side does — same hash, same three conditions — so a Mac that is signed in is
 * signed in here too, and signing out anywhere revokes both.
 *
 * The `apikey` Supabase requires is not identity. It says the request reached
 * the right project; it says nothing about who sent it, and anyone reading the
 * desktop bundle would have it. This is the part that decides.
 */

export interface Principal {
  userId: string;
  username: string;
  sessionId: string;
}

/** Same fingerprint the desktop stores: hex SHA-256 of the raw token. */
export async function fingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Resolve the bearer token to a person, or refuse.
 *
 * Expired, revoked, unknown and locked-out are deliberately one answer to the
 * caller. Telling an unauthenticated client *which* of those it was is telling
 * it whether a token it holds is real.
 */
// deno-lint-ignore no-explicit-any
export async function principalFor(req: Request, admin: any): Promise<Principal> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Sign in first.");

  const { data, error } = await admin
    .from("app_sessions")
    .select("id, user_id, expires_at, revoked_at, app_users!inner(username, locked_until)")
    .eq("token_hash", await fingerprint(token))
    .maybeSingle();

  if (error) throw new HttpError(500, "Could not check the sign-in.");
  if (!data) throw new HttpError(401, "That sign-in is no longer valid.");

  const now = Date.now();
  const expired = new Date(data.expires_at).getTime() <= now;
  const locked =
    data.app_users?.locked_until && new Date(data.app_users.locked_until).getTime() > now;
  if (data.revoked_at || expired || locked) {
    throw new HttpError(401, "That sign-in is no longer valid.");
  }

  // Best effort: knowing when a Mac last called is worth having, and worth
  // nothing enough that failing to record it must not fail the request.
  admin
    .from("app_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => {})
    .catch(() => {});

  return { userId: data.user_id, username: data.app_users.username, sessionId: data.id };
}


// --------------------------------------------------------------- signing in

/**
 * The pepper, from the function's own secrets.
 *
 * This is the value that used to live in the Mac's Keychain, and moving it here
 * is most of the point of phase 04: a PIN hash stolen from the database is
 * useless without it, and it is no longer something a laptop has to hold, prompt
 * for on every rebuild, or fail closed without.
 *
 * Set it with:  supabase secrets set COUNCIL_EDITOR_PIN_PEPPER=...
 */
function pepper(): string {
  const value = (Deno.env.get("COUNCIL_EDITOR_PIN_PEPPER") ?? "").trim();
  if (!value) {
    // Refused rather than defaulted to "". An empty pepper still verifies, so a
    // missing secret would look like it worked while silently removing the
    // protection it exists to provide.
    throw new HttpError(500, "Sign-in is not configured on the server.");
  }
  return value;
}

/** How long a session lasts. The desktop signs in each launch, so this is a
 *  working day rather than a "remember me". */
const SESSION_HOURS = 12;

export interface SignedIn {
  token: string;
  username: string;
  userId: string;
  expiresAt: string;
}

/**
 * Check a username and PIN, and mint a session.
 *
 * Every outcome except success returns the same sentence. Distinguishing "no
 * such account" from "wrong PIN" tells someone which usernames are worth
 * guessing, and a four-digit PIN cannot afford to give that away. The one
 * exception is a lockout, which the person needs to be told about because
 * waiting is the only thing that fixes it.
 */
// deno-lint-ignore no-explicit-any
export async function signIn(admin: any, username: string, pin: string): Promise<SignedIn> {
  const name = String(username ?? "").trim();
  const digits = String(pin ?? "").trim();
  if (!name || !/^[0-9]{4}$/.test(digits)) {
    throw new HttpError(401, "That username and PIN do not match.");
  }

  const { data, error } = await admin.rpc("auth_verify_pin", {
    p_username: name,
    p_pin: digits,
    p_pepper: pepper(),
  });
  if (error) {
    console.error("auth_verify_pin:", error.message ?? error);
    throw new HttpError(500, "Could not check that sign-in.");
  }

  const row = Array.isArray(data) ? data[0] : data;
  const outcome = row?.outcome ?? "no";

  if (outcome === "locked") {
    throw new HttpError(423, "Too many wrong PINs. Try again later.");
  }
  if (outcome === "needs_reset") {
    throw new HttpError(
      409,
      "This account's PIN predates server sign-in. Set it again from the desktop app."
    );
  }
  if (outcome !== "ok" || !row?.user_id) {
    throw new HttpError(401, "That username and PIN do not match.");
  }

  // The token is random; only its SHA-256 is stored, so this table is not a way
  // in on its own. Same scheme the desktop already used — what changed is that
  // the server mints it rather than the client.
  const raw = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();

  const { error: insertError } = await admin.from("app_sessions").insert({
    user_id: row.user_id,
    token_hash: await fingerprint(raw),
    label: "desktop",
    expires_at: expiresAt,
  });
  if (insertError) {
    console.error("mint session:", insertError.message ?? insertError);
    throw new HttpError(500, "Could not start that session.");
  }

  return { token: raw, username: row.matched_username, userId: row.user_id, expiresAt };
}
