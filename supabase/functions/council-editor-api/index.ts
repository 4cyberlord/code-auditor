/**
 * The Council Editor server API.
 *
 * Why it exists: the desktop app held the Supabase service-role key — full
 * project admin — in its Keychain and talked to Postgres and Storage directly.
 * That works, and it means a laptop is a credential. Everything the app needs
 * now goes through here instead: this process holds the key, and it checks who
 * is asking before it uses it.
 *
 * The shape is deliberately small. One POST, a named operation, a JSON body.
 * Not because REST would be wrong, but because there is exactly one client and
 * the property worth having is that every reachable query sits in a single
 * table in `ops.ts` that a person can read top to bottom and audit.
 *
 * Two layers of "who are you", doing different jobs:
 *   - Supabase's `apikey`, enforced by `withSupabase`, says the request reached
 *     the right project. It is in the shipped app, so it proves nothing about
 *     the sender.
 *   - A bearer token, checked in `auth.ts` against `app_sessions`, says which
 *     signed-in Mac this is. That is the one that decides.
 */

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { HttpError, principalFor } from "./auth.ts";
import { OPS, PUBLIC_OPS } from "./ops.ts";

/**
 * The desktop's webview is a browser, and a browser will send an OPTIONS
 * preflight before a POST that carries `authorization` and `apikey`. A 405 there
 * means the real request never leaves. Nothing here is cookie-authenticated —
 * the bearer token is what decides — so a wildcard origin grants nobody
 * anything they could not already do by sending the token themselves.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-max-age": "86400",
};

const JSON_HEADERS = { "content-type": "application/json", ...CORS_HEADERS };

function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: JSON_HEADERS });
}

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req: Request, ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") return fail(405, "Use POST.");

    let body: { op?: unknown; args?: unknown };
    try {
      body = await req.json();
    } catch {
      return fail(400, "Send a JSON body.");
    }

    const op = typeof body.op === "string" ? body.op : "";
    const publicHandler = PUBLIC_OPS[op];
    const handler = OPS[op];
    // Named rather than silently 404'd: a client asking for an operation this
    // deployment does not have is a version mismatch, and saying so is how
    // anyone finds that out.
    if (!publicHandler && !handler) return fail(400, `Unknown operation: ${op || "(none)"}`);

    const args = (body.args ?? {}) as Record<string, unknown>;

    try {
      // Signing in is the one thing that cannot require being signed in. It is
      // dispatched before `principalFor` runs, and it is the only entry in
      // PUBLIC_OPS — keeping that table to one line is what makes the
      // unauthenticated surface of this API reviewable at a glance.
      if (publicHandler) {
        const data = await publicHandler(ctx.supabaseAdmin, args);
        return new Response(JSON.stringify({ ok: true, data }), { headers: JSON_HEADERS });
      }

      const principal = await principalFor(req, ctx.supabaseAdmin);
      const data = await handler({ admin: ctx.supabaseAdmin, principal }, args);
      return new Response(JSON.stringify({ ok: true, data }), { headers: JSON_HEADERS });
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      // The detail goes to the function log, not to the caller: a database
      // error message can name columns and constraints, and a client has no
      // use for either.
      console.error(`op ${op} failed:`, err);
      return fail(500, "Something went wrong on the server.");
    }
  }),
};
