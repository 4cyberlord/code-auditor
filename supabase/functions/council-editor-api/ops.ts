/**
 * What the desktop is allowed to ask for.
 *
 * One table of named operations rather than a REST surface, for a reason worth
 * stating: this is not a public API. It has exactly one client, and the thing
 * that matters is that every reachable query is listed in one place a person can
 * read top to bottom and check. A path router spreads that across a file; a
 * table makes "what can a signed-in Mac do" a list.
 *
 * Every handler receives the admin client, which bypasses RLS — that is the
 * whole point of moving here. The service-role key stops living on a laptop and
 * starts living in one server-side place that checks who is asking first.
 */

import { fingerprint, HttpError, signIn, verifyPin, type Principal } from "./auth.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;
// deno-lint-ignore no-explicit-any
type Args = Record<string, any>;

export interface Ctx {
  admin: Admin;
  principal: Principal;
}

/** Platform rows are owned by the nil UUID. */
const PLATFORM_OWNER = "00000000-0000-0000-0000-000000000000";

/** The four that open the database and therefore cannot live inside it. */
const BOOTSTRAP_KEYS = new Set([
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
]);

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${name} is required.`);
  return v.trim();
};

const uuid = (v: unknown, name: string): string => {
  const s = str(v, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw new HttpError(400, `${name} is not an id.`);
  }
  return s;
};

/** Postgrest errors carry detail that is useful to us and not to a caller. */
// deno-lint-ignore no-explicit-any
function ok<T>(res: { data: T; error: any }, what: string): T {
  if (res.error) {
    console.error(`${what}:`, res.error.message ?? res.error);
    throw new HttpError(500, `Could not ${what}.`);
  }
  return res.data;
}

// PostgREST can see an older database schema for a while after an API deploy.
// Publishing the library should still work there; only the newer attribution
// warning has to degrade.
// deno-lint-ignore no-explicit-any
function missingColumns(err: any, names: string[]): boolean {
  const text = [
    err?.code,
    err?.message,
    err?.details,
    err?.hint,
  ].filter(Boolean).join(" ");
  if (!text) return false;
  const soundsLikeMissingColumn = /(column|schema cache|not find|does not exist|42703|PGRST204)/i.test(text);
  return soundsLikeMissingColumn && names.some((name) => text.includes(name));
}

// ------------------------------------------------------------------- shapes
//
// The desktop already had these shapes: `RunSummary`, `StoredResponse` and
// `StoredVerdict` are Rust structs the webview has been receiving since long
// before this function existed. Returning the raw Postgrest rows instead would
// have made moving a call here a reshaping job for every caller, which is how a
// transport swap turns into a rewrite. So the mapping happens once, here, and
// the Rust side deserialises straight into the struct it already serialises.

const iso = (v: unknown): string => {
  if (typeof v !== "string" || !v) return "";
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString();
};

/** Newest first. Nothing in the schema stops a run having two verdicts. */
// deno-lint-ignore no-explicit-any
const newestVerdict = (rows: any[] | null | undefined) =>
  [...(rows ?? [])].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
  )[0] ?? null;

// deno-lint-ignore no-explicit-any
function runSummary(r: any, answered: number) {
  const v = newestVerdict(r.verdicts);
  return {
    id: r.id,
    sessionId: r.session_id,
    mode: r.mode ?? "auto",
    asked: r.asked ?? "",
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    answered,
    verdict: v?.verdict ?? null,
    reliability: v?.reliability ?? null,
  };
}

// deno-lint-ignore no-explicit-any
function storedResponse(r: any) {
  return {
    id: r.id,
    provider: r.provider ?? "",
    model: r.model ?? "",
    attemptId: r.attempt_id ?? "",
    status: r.status ?? "",
    body: r.body ?? "",
    finalKind: r.final_kind ?? null,
    finalLanguage: r.final_language ?? null,
    finalAnswer: r.final_answer ?? null,
    finalCode: r.final_code ?? null,
    finalClaims: Array.isArray(r.final_claims) ? r.final_claims : [],
    complexity: r.complexity ?? null,
    confidence: typeof r.confidence === "number" ? r.confidence : null,
    wellFormed: Boolean(r.well_formed),
    inputTokens: r.input_tokens ?? null,
    outputTokens: r.output_tokens ?? null,
    elapsedMs: r.elapsed_ms ?? null,
    error: r.error ?? null,
  };
}

// deno-lint-ignore no-explicit-any
function storedVerdict(v: any) {
  return {
    verdict: v.verdict ?? "",
    headline: v.headline ?? null,
    detail: v.detail ?? null,
    reliability: v.reliability ?? null,
    outliers: Array.isArray(v.outliers) ? v.outliers : [],
    representative: v.representative ?? null,
    judgeProvider: v.judge_provider ?? null,
    judgeText: v.judge_text ?? null,
  };
}

/**
 * The operations that run before anyone is signed in.
 *
 * Exactly one, and it stays exactly one. Every other operation is reached only
 * after `principalFor` has resolved a bearer token, so this table is the entire
 * unauthenticated surface of the API and can be read in a second.
 */
export const PUBLIC_OPS: Record<string, (admin: Admin, args: Args) => Promise<unknown>> = {
  // Args are passed through unchecked on purpose: `signIn` validates them and
  // answers every failure with one sentence. A 400 saying "username is required"
  // would be a different answer from a 401, and different answers are what an
  // attacker enumerates with.
  "auth.login": (admin, args) => signIn(admin, args.username, args.pin),
};

// deno-lint-ignore no-explicit-any
function sessionRow(r: any) {
  return {
    id: r.id,
    title: r.title ?? "",
    note: r.note ?? "",
    context: r.context ?? "",
    status: r.status ?? "active",
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    screenshotCount: Number(r.screenshots?.[0]?.count ?? 0),
    runCount: Number(r.runs?.[0]?.count ?? 0),
  };
}

// deno-lint-ignore no-explicit-any
function screenshotRow(r: any) {
  return {
    id: r.id,
    sessionId: r.session_id,
    position: Number(r.position ?? 0),
    localPath: r.local_path ?? null,
    storagePath: r.storage_path ?? null,
    fileName: r.file_name ?? "",
    bytes: Number(r.bytes ?? 0),
    mime: r.mime ?? "",
    capturedAt: iso(r.captured_at),
    purged: Boolean(r.purged_at),
  };
}

// deno-lint-ignore no-explicit-any
function solveJobRow(r: any) {
  return {
    id: r.id,
    sessionId: r.session_id,
    mode: r.mode ?? "council",
    status: r.status ?? "",
    progressPhase: r.progress_phase ?? "",
    settingsSnapshot: r.settings_snapshot ?? {},
    error: r.error ?? null,
    resultSummary: r.result_summary ?? "",
    createdAt: iso(r.created_at),
    claimedAt: iso(r.claimed_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    updatedAt: iso(r.updated_at),
  };
}

// deno-lint-ignore no-explicit-any
function councilReportRow(r: any) {
  return {
    id: r.id,
    jobId: r.job_id,
    sessionId: r.session_id,
    winner: r.winner ?? null,
    synthesis: r.synthesis ?? "",
    markdown: r.markdown ?? "",
    report: r.report ?? {},
    createdAt: iso(r.created_at),
  };
}

// deno-lint-ignore no-explicit-any
function jobEventRow(r: any) {
  return {
    id: r.id,
    jobId: r.job_id,
    level: r.level ?? "info",
    phase: r.phase ?? "",
    message: r.message ?? "",
    payload: r.payload ?? {},
    createdAt: iso(r.created_at),
  };
}

// deno-lint-ignore no-explicit-any
function jobImageRow(r: any) {
  return {
    id: r.id,
    jobId: r.job_id,
    sessionId: r.session_id,
    position: Number(r.position ?? 0),
    storageBucket: r.storage_bucket ?? "",
    storagePath: r.storage_path ?? "",
    fileName: r.file_name ?? "",
    bytes: Number(r.bytes ?? 0),
    mime: r.mime ?? "",
    width: r.width ?? null,
    height: r.height ?? null,
    createdAt: iso(r.created_at),
  };
}

export const OPS: Record<string, (ctx: Ctx, args: Args) => Promise<unknown>> = {
  /** Liveness plus identity, so a client can prove its token in one call. */
  "auth.whoami": async ({ principal }) => ({
    username: principal.username,
    userId: principal.userId,
  }),

  /** End this session. The token stops working everywhere, immediately. */
  "auth.logout": async ({ admin, principal }) => {
    const { error } = await admin
      .from("app_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", principal.sessionId);
    if (error) {
      console.error("logout:", error.message ?? error);
      throw new HttpError(500, "Could not sign out.");
    }
    return { signedOut: true };
  },

  /** Prove the person at the keyboard still knows the account PIN. */
  "auth.reauthenticate": async ({ admin, principal }, args) => {
    await verifyPin(admin, principal.username, args.pin);
    return { verified: true };
  },

  /**
   * Change the PIN, proving the current one first.
   *
   * Also the way an account moves off the old local Argon2id hash: the server
   * cannot verify those, so `auth.login` returns "needs_reset" and this is what
   * resolves it — which is why it accepts the current PIN through the same
   * verify path rather than trusting the session alone.
   */
  "auth.changePin": async ({ admin, principal }, args) => {
    const next = String(args.nextPin ?? "").trim();
    if (!/^[0-9]{4}$/.test(next)) throw new HttpError(400, "The PIN has to be exactly 4 digits.");
    if (next === String(args.currentPin ?? "").trim()) {
      throw new HttpError(400, "That is the PIN you already have.");
    }

    // Proves the person at the keyboard is the account holder, not just someone
    // holding an unlocked session.
    try {
      await signIn(admin, principal.username, args.currentPin);
    } catch (err) {
      // 409 means this account's hash predates server verification, and that is
      // precisely the account this operation exists to rescue. Demanding a proof
      // the server is structurally unable to perform would make the migration
      // impossible — the PIN could never be changed, so the hash could never be
      // upgraded, so the PIN could never be changed.
      //
      // The bearer token is the proof instead, and it is a real one: the desktop
      // mints it only after verifying this same PIN against the Argon2id hash
      // locally. The narrowing is that a stolen session could set a new PIN
      // without knowing the old one — true only for accounts still on the old
      // hash, and permanently untrue for each account after its first change.
      //
      // Every other refusal — wrong PIN, locked, unknown — still stands.
      if (!(err instanceof HttpError) || err.status !== 409) throw err;
    }

    const { error } = await admin.rpc("auth_set_pin", {
      p_user_id: principal.userId,
      p_pin: next,
      p_pepper: Deno.env.get("COUNCIL_EDITOR_PIN_PEPPER") ?? "",
    });
    if (error) {
      console.error("auth_set_pin:", error.message ?? error);
      throw new HttpError(500, "Could not change the PIN.");
    }

    // Every other session was opened with the old PIN, so none of them survive it.
    await admin
      .from("app_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", principal.userId)
      .neq("id", principal.sessionId)
      .is("revoked_at", null);

    return { changed: true };
  },

  /**
   * Mint a 30-day token for the background capture helper.
   *
   * The helper is a LaunchAgent: it runs when the app is closed, which is the
   * entire point of it, so it cannot borrow the app's in-memory session. It gets
   * a credential of its own — and this is the one thing on the Mac that is
   * deliberately stored, so it is worth being precise about what it is.
   *
   * It is scoped (a session row like any other), it expires in thirty days, and
   * it is revocable from the database at any time. Minting a new one revokes the
   * old one, so "re-authorise the helper" is a complete rotation rather than an
   * accumulation of live tokens nobody is tracking.
   */
  "auth.helperToken": async ({ admin, principal }) => {
    const now = new Date().toISOString();
    // Revoke first. A helper that is re-authorised should not leave its previous
    // token working for the rest of its thirty days on some machine nobody is
    // thinking about any more.
    const revoked = await admin
      .from("app_sessions")
      .update({ revoked_at: now })
      .eq("user_id", principal.userId)
      .eq("label", "helper")
      .is("revoked_at", null);
    if (revoked.error) {
      console.error("revoke helper sessions:", revoked.error.message ?? revoked.error);
      throw new HttpError(500, "Could not replace the helper's authorisation.");
    }

    const raw = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const { error } = await admin.from("app_sessions").insert({
      user_id: principal.userId,
      token_hash: await fingerprint(raw),
      label: "helper",
      expires_at: expiresAt,
    });
    if (error) {
      console.error("mint helper token:", error.message ?? error);
      throw new HttpError(500, "Could not authorise the helper.");
    }
    return { token: raw, expiresAt };
  },

  /** When the helper's authorisation runs out, so the UI can offer to renew. */
  "auth.helperStatus": async ({ admin, principal }) => {
    const rows = ok(
      await admin
        .from("app_sessions")
        .select("expires_at")
        .eq("user_id", principal.userId)
        .eq("label", "helper")
        .is("revoked_at", null)
        .order("expires_at", { ascending: false })
        .limit(1),
      "read the helper's authorisation"
      // deno-lint-ignore no-explicit-any
    ) as any[];
    const expiresAt = rows[0]?.expires_at ?? null;
    return {
      authorised: Boolean(expiresAt) && new Date(expiresAt).getTime() > Date.now(),
      expiresAt: expiresAt ? iso(expiresAt) : null,
    };
  },

  // ------------------------------------------------------------- sessions

  "sessions.list": async ({ admin, principal }, args) => {
    const status = args.status === "archived" ? "archived" : "active";
    const rows = ok(
      await admin
        .from("sessions")
        .select("*, screenshots(count), runs(count)")
        .eq("owner_id", principal.userId)
        .eq("status", status)
        .order("updated_at", { ascending: false }),
      "list sessions"
      // deno-lint-ignore no-explicit-any
    ) as any[];
    return rows.map(sessionRow);
  },

  "sessions.create": async ({ admin, principal }, args) =>
    ok(
      await admin
        .from("sessions")
        // The owner is taken from the token, never from the request body. A
        // client that could name the owner of a row it is creating could put a
        // session in someone else's account.
        .insert({
          title: typeof args.title === "string" ? args.title : "",
          owner_id: principal.userId,
        })
        .select("id")
        .single(),
      "create the session"
    ),

  "sessions.update": async ({ admin, principal }, args) => {
    // An allow-list rather than a column name from the caller. `update({ [field]:
    // value })` with an unchecked key lets a client write any column it can name
    // — `owner_id` included, which would be a way to hand a session to somebody
    // else or take one from them.
    const field = String(args.field ?? "title");
    if (!["title", "note", "context"].includes(field)) {
      throw new HttpError(400, `"${field}" is not an editable session field.`);
    }
    const value = typeof args.value === "string" ? args.value : "";
    return ok(
      await admin
        .from("sessions")
        .update({ [field]: value, updated_at: new Date().toISOString() })
        .eq("id", uuid(args.id, "id"))
        .eq("owner_id", principal.userId)
        .select("id"),
      "update the session"
    );
  },

  "sessions.setStatus": async ({ admin, principal }, args) => {
    const status = args.status === "archived" ? "archived" : "active";
    return ok(
      await admin
        .from("sessions")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", uuid(args.id, "id"))
        .eq("owner_id", principal.userId)
        .select("id")
        .single(),
      "change the session status"
    );
  },

  "sessions.delete": async ({ admin, principal }, args) => {
    const id = uuid(args.id, "id");
    // Read the on-disk paths before the rows go, so the desktop can remove the
    // files. After the delete they are unrecoverable — the row was the only
    // record of where the bytes were.
    const shots = ok(
      await admin
        .from("screenshots")
        .select("local_path")
        .eq("session_id", id)
        .eq("owner_id", principal.userId)
        .not("local_path", "is", null)
        .is("purged_at", null),
      "read the session's screenshots"
      // deno-lint-ignore no-explicit-any
    ) as any[];

    ok(
      await admin.from("sessions").delete().eq("id", id).eq("owner_id", principal.userId).select("id"),
      "delete the session"
    );
    return shots.map((r) => r.local_path).filter(Boolean);
  },

  /** Add one uploaded screenshot. Position is next-in-session, computed here. */
  "screenshots.add": async ({ admin, principal }, args) => {
    const sessionId = uuid(args.sessionId, "sessionId");
    // Proves the session is this person's before anything is written into it.
    const owned = ok(
      await admin
        .from("sessions")
        .select("id")
        .eq("id", sessionId)
        .eq("owner_id", principal.userId)
        .maybeSingle(),
      "find the session"
    );
    if (!owned) throw new HttpError(404, "That session no longer exists.");

    const last = ok(
      await admin
        .from("screenshots")
        .select("position")
        .eq("session_id", sessionId)
        .order("position", { ascending: false })
        .limit(1),
      "find the next position"
      // deno-lint-ignore no-explicit-any
    ) as any[];

    const row = ok(
      await admin
        .from("screenshots")
        .insert({
          session_id: sessionId,
          owner_id: principal.userId,
          position: last.length ? Number(last[0].position) + 1 : 0,
          storage_bucket: str(args.storageBucket, "storageBucket"),
          storage_path: str(args.storagePath, "storagePath"),
          uploaded_at: new Date().toISOString(),
          file_name: str(args.fileName, "fileName"),
          bytes: Number(args.bytes ?? 0),
          mime: str(args.mime, "mime"),
          width: args.width ?? null,
          height: args.height ?? null,
        })
        .select("id")
        .single(),
      "save the screenshot"
    );
    // deno-lint-ignore no-explicit-any
    return { id: (row as any).id };
  },

  // ---------------------------------------------------------- screenshots

  "screenshots.list": async ({ admin, principal }, args) => {
    const rows = ok(
      await admin
        .from("screenshots")
        .select("*")
        .eq("session_id", uuid(args.sessionId, "sessionId"))
        .eq("owner_id", principal.userId)
        .order("position"),
      "list screenshots"
      // deno-lint-ignore no-explicit-any
    ) as any[];
    return rows.map(screenshotRow);
  },

  "screenshots.remove": async ({ admin, principal }, args) =>
    ok(
      await admin
        .from("screenshots")
        .delete()
        .eq("id", uuid(args.id, "id"))
        .eq("owner_id", principal.userId)
        .select("id"),
      "remove the screenshot"
    ),

  /**
   * Forget the pictures, keep the record.
   *
   * The row survives with `purged_at` set, so a session still reads correctly
   * with the sensitive part gone — which is the whole point: "delete the
   * screenshots" should not also delete the history of having solved something.
   * The local paths come back so the caller can remove its own files.
   */
  "screenshots.purge": async ({ admin, principal }, args) => {
    const sessionId = uuid(args.sessionId, "sessionId");
    // Read the paths before nulling them: one statement cannot return a column
    // it has just cleared.
    const rows = ok(
      await admin
        .from("screenshots")
        .select("local_path")
        .eq("session_id", sessionId)
        .eq("owner_id", principal.userId)
        .not("local_path", "is", null)
        .is("purged_at", null),
      "read the session's screenshots"
      // deno-lint-ignore no-explicit-any
    ) as any[];

    ok(
      await admin
        .from("screenshots")
        .update({ local_path: null, purged_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("owner_id", principal.userId)
        .is("purged_at", null),
      "forget the screenshots"
    );
    return rows.map((r) => r.local_path).filter(Boolean);
  },

  // ----------------------------------------------------------------- runs

  "runs.list": async ({ admin, principal }, args) => {
    const rows = ok(
      await admin
        .from("runs")
        .select(
          "id, session_id, mode, asked, started_at, finished_at, " +
            "agent_responses(count), verdicts(verdict, reliability, created_at)"
        )
        .eq("session_id", uuid(args.sessionId, "sessionId"))
        .eq("owner_id", principal.userId)
        .order("started_at", { ascending: false }),
      "list runs"
      // deno-lint-ignore no-explicit-any
    ) as any[];
    return rows.map((r) => runSummary(r, Number(r.agent_responses?.[0]?.count ?? 0)));
  },

  /**
   * Save a finished run: the run, its answers and its verdict, atomically.
   *
   * A Postgres function rather than three inserts, because three inserts over
   * HTTP is three chances to stop halfway and leave a run that looks complete
   * and is not. The desktop had a transaction here and moving to the server
   * should not cost it one.
   */
  "runs.save": async ({ admin, principal }, args) => {
    const { data, error } = await admin.rpc("run_save", {
      p_owner: principal.userId,
      p_session: uuid(args.sessionId, "sessionId"),
      p_mode: typeof args.mode === "string" ? args.mode : "auto",
      p_asked: typeof args.asked === "string" ? args.asked : "",
      p_context_mode: typeof args.contextMode === "string" ? args.contextMode : "images",
      p_extracted_context: typeof args.extractedContext === "string" ? args.extractedContext : "",
      p_extraction_agreed: typeof args.extractionAgreed === "boolean" ? args.extractionAgreed : null,
      p_responses: Array.isArray(args.responses) ? args.responses : [],
      p_verdict: args.verdict ?? null,
    });
    if (error) {
      // P0002 is the function's own "not your session", raised rather than
      // written. Anything else is ours to look at, not the caller's.
      if (String(error.code) === "P0002" || /no such session/.test(error.message ?? "")) {
        throw new HttpError(404, "That session no longer exists.");
      }
      console.error("run_save:", error.message ?? error);
      throw new HttpError(500, "Could not save the run.");
    }
    return { id: data };
  },

  "runs.get": async ({ admin, principal }, args) => {
    const runId = uuid(args.runId, "runId");
    // Only the run itself is scoped by owner. Its answers and verdict are keyed
    // by run_id and unreachable except through a run that just proved it belongs
    // to this person — so the check below is the whole gate, and the 404 it
    // raises is what someone else's run id looks like from here.
    const [run, responses, verdict] = await Promise.all([
      admin.from("runs").select("*").eq("id", runId).eq("owner_id", principal.userId).maybeSingle(),
      admin.from("agent_responses").select("*").eq("run_id", runId).order("created_at"),
      // Not maybeSingle: PostgREST raises on a second row, and nothing in the
      // schema stops a run from having one. Newest wins, same as the Rust side.
      admin
        .from("verdicts")
        .select("*")
        .eq("run_id", runId)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    const row = ok(run, "read the run");
    if (!row) throw new HttpError(404, "That run no longer exists.");
    // deno-lint-ignore no-explicit-any
    const answers = ok(responses, "read the run's answers") as any[];
    // deno-lint-ignore no-explicit-any
    const verdicts = ok(verdict, "read the verdict") as any[];
    return {
      run: runSummary({ ...row, verdicts }, answers.length),
      responses: answers.map(storedResponse),
      verdict: verdicts[0] ? storedVerdict(verdicts[0]) : null,
    };
  },

  // ------------------------------------------------------------ solve jobs

  /** Queue a background solve job: the job, its screenshots and its first event, atomically. */
  "jobs.create": async ({ admin, principal }, args) => {
    const mode = args.mode === "mcq" ? "mcq" : "council";
    const { data, error } = await admin.rpc("solve_job_create", {
      p_owner: principal.userId,
      p_session: uuid(args.sessionId, "sessionId"),
      p_mode: mode,
      p_settings: args.settingsSnapshot ?? {},
      p_images: Array.isArray(args.images) ? args.images : [],
      p_submission: uuid(args.submissionId, "submissionId"),
    });
    if (error) {
      if (String(error.code) === "P0002" || /no such session/.test(error.message ?? "")) {
        throw new HttpError(404, "That session no longer exists.");
      }
      if (String(error.code) === "23505") throw new HttpError(409, "Submission identity reused with different data.");
      console.error("solve_job_create:", error.message ?? error);
      throw new HttpError(500, "Could not queue the job.");
    }
    return { id: data };
  },

  /** Set the order of a session's screenshots in one statement. */
  "screenshots.reorder": async ({ admin, principal }, args) => {
    const ids = Array.isArray(args.ids) ? args.ids.map((v: unknown) => uuid(v, "id")) : [];
    const { error } = await admin.rpc("screenshots_reorder", {
      p_owner: principal.userId,
      p_session: uuid(args.sessionId, "sessionId"),
      p_ids: ids,
    });
    if (error) {
      console.error("screenshots_reorder:", error.message ?? error);
      throw new HttpError(500, "Could not save the new order.");
    }
    return { ordered: ids.length };
  },

  /** Fetch one tracked solve job directly; the newest-50 listing is for browsing. */
  "jobs.get": async ({ admin, principal }, args) => {
    const row = ok(
      await admin.from("solve_jobs").select("*")
        .eq("id", uuid(args.jobId, "jobId"))
        .eq("owner_id", principal.userId)
        .maybeSingle(),
      "get cloud job"
    );
    return row ? solveJobRow(row) : null;
  },

  "jobs.list": async ({ admin, principal }, args) => {
    let q = admin
      .from("solve_jobs")
      .select("*")
      .eq("owner_id", principal.userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (typeof args.status === "string" && args.status !== "all") q = q.eq("status", args.status);
    // deno-lint-ignore no-explicit-any
    return (ok(await q, "list cloud jobs") as any[]).map(solveJobRow);
  },

  "jobs.events": async ({ admin, principal }, args) =>
    (ok(
      await admin
        .from("solve_job_events")
        .select("*")
        .eq("job_id", uuid(args.jobId, "jobId"))
        .eq("owner_id", principal.userId)
        .order("created_at"),
      "read the job's events"
      // deno-lint-ignore no-explicit-any
    ) as any[]).map(jobEventRow),

  "jobs.images": async ({ admin, principal }, args) =>
    (ok(
      await admin
        .from("solve_job_images")
        .select("*")
        .eq("job_id", uuid(args.jobId, "jobId"))
        .eq("owner_id", principal.userId)
        .order("position"),
      "read the job's screenshots"
      // deno-lint-ignore no-explicit-any
    ) as any[]).map(jobImageRow),

  "reports.get": async ({ admin, principal }, args) => {
    const row = ok(
      await admin
        .from("council_reports")
        .select("*")
        .eq("job_id", uuid(args.jobId, "jobId"))
        .eq("owner_id", principal.userId)
        .maybeSingle(),
      "read the council report"
    );
    return row ? councilReportRow(row) : null;
  },

  // --------------------------------------------------------- configuration

  /** Every config value, secret contents withheld. */
  /**
   * Publish the knowledge library the desktop has on disk.
   *
   * The library is markdown files on someone's Mac, and the cloud worker reads
   * `intelligence_records`. This is the bridge between the two, and it is a
   * deliberate act rather than a background sync: what a person is still
   * writing should not reach a running job until they say so.
   *
   * Upserts only. Nothing is deleted, because the database is shared with
   * whatever else has been added to it and a laptop's folder is not the whole
   * truth about the library.
   */
  "knowledge.publish": async ({ admin, principal }, args) => {
    const records = Array.isArray(args.records) ? args.records : [];
    if (!records.length) throw new HttpError(400, "There is nothing to publish.");
    if (records.length > 500) throw new HttpError(400, "That is more records than this operation accepts.");

    const KINDS = new Set(["pattern", "problem", "runtime", "resource"]);
    const rows: Record<string, unknown>[] = [];
    const sources = new Map<string, Record<string, unknown>>();

    for (const raw of records) {
      const record = (raw ?? {}) as Record<string, unknown>;
      const id = str(record.id, "id");
      if (!/^[a-z0-9_-]+$/.test(id)) throw new HttpError(400, `"${id}" is not a usable record id.`);
      const kind = String(record.kind ?? "");
      if (!KINDS.has(kind)) throw new HttpError(400, `"${kind}" is not a record kind.`);
      const guidance = Array.isArray(record.guidance)
        ? record.guidance.filter((g: unknown) => typeof g === "string" && g.trim()).map((g: string) => g.trim())
        : [];
      // The same rule the app applies before it offers to publish: guidance is
      // the part that reaches a model, and a record without it is a draft.
      if (!guidance.length) throw new HttpError(400, `"${id}" has no guidance, so it is not ready to publish.`);

      const tags = Array.isArray(record.tags)
        ? record.tags.filter((t: unknown) => typeof t === "string" && t.trim()).map((t: string) => t.trim().toLowerCase())
        : [];
      const recordSources = Array.isArray(record.sources) ? record.sources : [];
      const urls: string[] = [];
      for (const rawSource of recordSources) {
        const source = (rawSource ?? {}) as Record<string, unknown>;
        const url = typeof source.url === "string" ? source.url.trim() : "";
        if (!/^https?:\/\//.test(url)) continue;
        urls.push(url);
        if (!sources.has(url)) {
          sources.set(url, {
            id: url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80),
            title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : url,
            url,
            trust: typeof source.trust === "string" && ["official", "academic", "reference", "community"].includes(source.trust)
              ? source.trust
              : "reference",
            note: typeof source.note === "string" ? source.note : "",
            tags: [],
          });
        }
      }

      rows.push({
        id,
        title: str(record.title, "title"),
        kind,
        summary: typeof record.summary === "string" ? record.summary : "",
        guidance,
        tags,
        complexity: typeof record.complexity === "string" && record.complexity.trim() ? record.complexity.trim() : null,
        target_runtime_ms: typeof record.targetRuntimeMs === "number" ? record.targetRuntimeMs : null,
        target_memory_mb: typeof record.targetMemoryMb === "number" ? record.targetMemoryMb : null,
        source_urls: urls,
        updated_at: new Date().toISOString(),
      });
    }

    // What is already there, before it is replaced.
    //
    // The shelf is shared, so a publish from one Mac can land on a record
    // another one wrote. Ownership is the wrong fix — the worker reads this
    // library with no principal and would have to guess whose to use — so the
    // fix is that an overwrite is attributable and reported instead of silent.
    const ids = rows.map((r) => r.id as string);
    let canAttributePublishes = true;
    let existingResult = await admin
      .from("intelligence_records")
      .select("id, title, guidance, summary, published_by, updated_at")
      .in("id", ids);
    if (existingResult.error && missingColumns(existingResult.error, ["published_by"])) {
      canAttributePublishes = false;
      existingResult = await admin
        .from("intelligence_records")
        .select("id, title, guidance, summary, updated_at")
        .in("id", ids);
    }
    const existing = (ok(
      existingResult,
      "read the current library"
      // deno-lint-ignore no-explicit-any
    ) ?? []) as any[];

    const before = new Map(existing.map((row) => [row.id, row]));
    const replaced: { id: string; title: string; by: string | null; at: string | null }[] = [];
    for (const row of rows) {
      const was = before.get(row.id as string);
      if (!was) continue;
      const changed =
        JSON.stringify(was.guidance ?? []) !== JSON.stringify(row.guidance) ||
        String(was.summary ?? "") !== String(row.summary ?? "") ||
        String(was.title ?? "") !== String(row.title ?? "");
      // Republishing a record unchanged is not an overwrite worth reporting;
      // replacing someone's different text is.
      if (!changed) continue;
      if (canAttributePublishes && was.published_by && was.published_by !== principal.userId) {
        replaced.push({ id: was.id, title: was.title ?? was.id, by: was.published_by, at: was.updated_at ?? null });
      }
    }

    const stamped = rows.map((row) => ({
      ...row,
      published_by: principal.userId,
      published_at: new Date().toISOString(),
    }));

    if (sources.size) {
      ok(
        await admin.from("intelligence_sources").upsert([...sources.values()], { onConflict: "url" }),
        "save the sources"
      );
    }
    let saveResult = await admin
      .from("intelligence_records")
      .upsert(canAttributePublishes ? stamped : rows, { onConflict: "id" });
    if (saveResult.error && missingColumns(saveResult.error, ["published_by", "published_at"])) {
      canAttributePublishes = false;
      saveResult = await admin.from("intelligence_records").upsert(rows, { onConflict: "id" });
    }
    ok(saveResult, "save the knowledge records");

    return { published: rows.length, sources: sources.size, replaced };
  },

  "config.list": async ({ admin, principal }) => {
    const rows = ok(
      await admin
        .from("app_config")
        .select("key, value, secret, updated_at, owner_id")
        .or(`owner_id.eq.${principal.userId},owner_id.eq.${PLATFORM_OWNER}`)
        .order("key"),
      "read the configuration"
      // deno-lint-ignore no-explicit-any
    ) as any[];

    // Your own row shadows a platform one. Sorted with yours last so the map
    // overwrite lands the right way round.
    const merged = new Map<string, unknown>();
    for (const r of [...rows].sort((a, b) => (a.owner_id === PLATFORM_OWNER ? -1 : 1))) {
      merged.set(r.key, {
        key: r.key,
        // The withholding happens here rather than being left to callers. A
        // redaction someone has to remember is a redaction someone forgets.
        value: r.secret ? "" : String(r.value ?? ""),
        secret: Boolean(r.secret),
        isSet: String(r.value ?? "").trim().length > 0,
        platform: r.owner_id === PLATFORM_OWNER,
        updatedAt: iso(r.updated_at),
      });
    }
    return [...merged.values()];
  },

  /** Save one value against the person saving it. Never the platform tier. */
  "config.set": async ({ admin, principal }, args) => {
    const key = str(args.key, "key");
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new HttpError(400, "That is not a configuration key.");
    if (BOOTSTRAP_KEYS.has(key.toUpperCase())) {
      throw new HttpError(400, `${key} is what opens the database, so it cannot be stored inside it.`);
    }
    const value = typeof args.value === "string" ? args.value.trim() : "";
    if (!value) {
      ok(
        await admin.from("app_config").delete().eq("owner_id", principal.userId).eq("key", key),
        "remove the value"
      );
      return { removed: true };
    }
    ok(
      await admin.from("app_config").upsert(
        {
          owner_id: principal.userId,
          key,
          value,
          secret: Boolean(args.secret),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "owner_id,key" }
      ),
      "save the value"
    );
    return { saved: true };
  },

  "config.delete": async ({ admin, principal }, args) => {
    ok(
      await admin
        .from("app_config")
        .delete()
        .eq("owner_id", principal.userId)
        .eq("key", str(args.key, "key")),
      "remove the value"
    );
    return { removed: true };
  },

  /**
   * The signed-in person's secret values, in full.
   *
   * The one operation that returns secrets, and it exists because outbound calls
   * need them: the desktop holds these in memory for the session and never shows
   * them to its own webview. Scoped to the caller and merged with the platform
   * tier, exactly as `config.list` is — the difference is only that values come
   * back.
   */
  "secrets.load": async ({ admin, principal }) => {
    const rows = ok(
      await admin
        .from("app_config")
        .select("key, value, owner_id")
        .eq("secret", true)
        .or(`owner_id.eq.${principal.userId},owner_id.eq.${PLATFORM_OWNER}`),
      "read the saved keys"
      // deno-lint-ignore no-explicit-any
    ) as any[];

    const out: Record<string, string> = {};
    for (const r of [...rows].sort((a, b) => (a.owner_id === PLATFORM_OWNER ? -1 : 1))) {
      const value = String(r.value ?? "").trim();
      if (value) out[r.key] = value;
    }
    return out;
  },

  // ------------------------------------------------------------- settings

  "settings.load": async ({ admin, principal }, args) => {
    const rows = ok(
      await admin
        .from("settings")
        .select("value, owner_id")
        .eq("key", str(args.key, "key"))
        .or(`owner_id.eq.${principal.userId},owner_id.eq.${PLATFORM_OWNER}`),
      "load settings"
      // deno-lint-ignore no-explicit-any
    ) as any[];
    const mine = rows.find((r) => r.owner_id === principal.userId);
    return (mine ?? rows[0])?.value ?? null;
  },

  "settings.save": async ({ admin, principal }, args) => {
    ok(
      await admin.from("settings").upsert(
        {
          owner_id: principal.userId,
          key: str(args.key, "key"),
          value: args.value ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "owner_id,key" }
      ),
      "save settings"
    );
    return { saved: true };
  },

  // -------------------------------------------------------------- storage

  /**
   * A URL the desktop can PUT a screenshot to.
   *
   * The bytes do not come through here. A few megabytes of PNG through an Edge
   * Function costs latency and memory to achieve nothing — the point was never
   * to proxy the data, it was to stop the desktop holding a key that can write
   * anywhere. A signed upload URL is good for one path, once.
   */
  "storage.uploadUrl": async ({ admin, principal }, args) => {
    const path = str(args.path, "path");
    if (path.includes("..") || path.startsWith("/") || path.includes("//")) {
      throw new HttpError(400, "That is not a storage path.");
    }
    // Every upload lands under the uploader's own id.
    //
    // Without this an account could sign a URL for any path in the bucket and
    // overwrite somebody else's screenshot — a signed *upload* URL is a write,
    // and the ownership checks that guard `storage.sign` and `storage.remove`
    // work off rows that do not exist yet at upload time. The prefix is the only
    // thing that can carry ownership before there is a row to consult.
    if (!path.startsWith(`${principal.userId}/`)) {
      throw new HttpError(400, "An upload path has to start with your own account id.");
    }
    const bucket = typeof args.bucket === "string" && args.bucket.trim() ? args.bucket.trim() : "screenshots";
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bucket)) throw new HttpError(400, "That is not a bucket.");

    const { data, error } = await admin.storage.from(bucket).createSignedUploadUrl(path, { upsert: args.idempotent === true });
    if (error) {
      console.error("signed upload url:", error.message ?? error);
      throw new HttpError(500, "Could not start that upload.");
    }
    return { url: data.signedUrl, token: data.token, path: data.path, bucket };
  },

  /** Delete a stored object, but only one this project actually recorded. */
  "storage.remove": async ({ admin, principal }, args) => {
    const path = str(args.path, "path");
    const bucket = typeof args.bucket === "string" && args.bucket.trim() ? args.bucket.trim() : "screenshots";

    const known = await Promise.all([
      admin.from("screenshots").select("id").eq("storage_bucket", bucket)
        .eq("storage_path", path).eq("owner_id", principal.userId).limit(1),
      admin.from("solve_job_images").select("id").eq("storage_bucket", bucket)
        .eq("storage_path", path).eq("owner_id", principal.userId).limit(1),
    ]);
    for (const res of known) {
      if (res.error) {
        console.error("check storage path:", res.error.message ?? res.error);
        throw new HttpError(500, "Could not check that screenshot.");
      }
    }
    if (!known.some((res) => Array.isArray(res.data) && res.data.length > 0)) {
      throw new HttpError(404, "That screenshot is not one of ours.");
    }

    const { error } = await admin.storage.from(bucket).remove([path]);
    if (error) {
      console.error("storage remove:", error.message ?? error);
      throw new HttpError(500, "Could not delete that screenshot.");
    }
    return { removed: true };
  },


  /**
   * A time-limited URL for one stored screenshot.
   *
   * This is the endpoint that most justifies the whole function. Signing needs
   * the service-role key; handing that key to a desktop app so it can sign its
   * own URLs is what we are moving away from. The client asks, the server signs,
   * and the key never leaves.
   */
  "storage.sign": async ({ admin, principal }, args) => {
    const path = str(args.path, "path");
    // Shape first, so the obvious escapes never reach a lookup.
    if (path.includes("..") || path.startsWith("/") || path.includes("//")) {
      throw new HttpError(400, "That is not a storage path.");
    }
    const bucket =
      typeof args.bucket === "string" && args.bucket.trim() ? args.bucket.trim() : "screenshots";
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bucket)) throw new HttpError(400, "That is not a bucket.");

    // The real gate, and the reason this is not just a shape check: signing runs
    // with the service-role key, so an unchecked path is a signed URL for any
    // object in the project. A path is signable only if this project actually
    // stored it — as a session screenshot or as a solve job's image. Anything
    // else is refused whether it exists or not.
    const known = await Promise.all([
      admin
        .from("screenshots")
        .select("id")
        .eq("storage_bucket", bucket)
        .eq("storage_path", path)
        .eq("owner_id", principal.userId)
        .limit(1),
      admin
        .from("solve_job_images")
        .select("id")
        .eq("storage_bucket", bucket)
        .eq("storage_path", path)
        .eq("owner_id", principal.userId)
        .limit(1),
    ]);
    for (const res of known) {
      if (res.error) {
        console.error("check storage path:", res.error.message ?? res.error);
        throw new HttpError(500, "Could not check that screenshot.");
      }
    }
    if (!known.some((res) => Array.isArray(res.data) && res.data.length > 0)) {
      throw new HttpError(404, "That screenshot is not one of ours.");
    }

    const seconds = Math.min(Math.max(Number(args.seconds) || 900, 30), 3600);
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, seconds);
    if (error) {
      console.error("sign storage url:", error.message ?? error);
      throw new HttpError(404, "That screenshot is not in storage.");
    }
    return { url: data.signedUrl, expiresIn: seconds };
  },
};
