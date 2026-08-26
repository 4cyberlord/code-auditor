/**
 * What a probe error actually means.
 *
 * The classifier is deliberately stingy: it only ever re-labels a failure when
 * the provider's own error is unambiguous about why — a 429, a name the API
 * does not have, an endpoint that refuses the SDK shape. Anything stranger
 * stays raw, because a polished lie is worse than an ugly truth.
 *
 * It is pure and unit-tested: no Tauri, no WebView, no network.
 */

export type ProbeStatus = "ok" | "failed" | "unsupported";
/** Which wire a model speaks; "chat" is everything not explicitly overridden. */
export type EndpointOverride = "chat" | "responses";

export interface ProbeReport {
  status: ProbeStatus;
  /**
   * One line for the toast body. May be followed by `detail` on a new line.
   *
   * - `ok`:         something like "openai/gpt-5.6-sol answered in 240ms".
   * - `failed`:     the human reason — "rate limited: 20s to wait".
   * - `unsupported`:the model lives on a different wire. The pane row shows it
   *                 as such so you know it is not a credential problem.
   */
  summary: string;
  /** Optional second line — the exact remedy when we can name it. */
  detail?: string;
  /**
   * What the retry envelope should be, in ms. `0` when not applicable.
   *
   * Only set for something the server itself told us: a parsed `Retry-After`
   * header on a 429 error body is the one number we are willing to spend
   * another request's wait on verbatim.
   */
  retryAfterMs: number;
  /**
   * Set when the provider named a different wire outright. The UI reads this
   * to offer "switch this model to it" as a button instead of leaving the
   * same probe to produce the same 400 on every future press.
   */
  suggestEndpoint?: EndpointOverride;
  /** The raw error text as the provider sent it, for the tooltip. Never lost. */
  raw: string;
}

/**
 * Reads one model's probe result and decides how to present it.
 * The pair (ok, error) is the whole contract: an ok result ignores `raw`.
 */
export function classifyProbeResult(
  model: string,
  ok: boolean,
  error: string | null | undefined,
  ms?: number
): ProbeReport {
  const raw = (error ?? "").trim();
  if (ok) {
    return {
      status: "ok",
      summary: `${model} answered${ms ? ` in ${ms}ms` : ""}.`,
      retryAfterMs: 0,
      raw: "",
    };
  }
  if (!raw) {
    return { status: "failed", summary: `${model} failed for an unknown reason.`, retryAfterMs: 0, raw: "" };
  }

  const lower = raw.toLowerCase();

  // Rate ceilings. The gateway's own message says "request limit" for the
  // per-minute plan and "concurrency limit" for the floods. Both are the same
  // advice to the user even though only one says a number.
  const rpm = lower.match(/(\d+)\s*requests?\s*within\s*\d+\s*min/);
  if (lower.includes("429") || lower.includes("rate limit") || rpm) {
    const perMin = rpm ? rpm[1] : null;
    const retryAfterMs = parseRetryAfter(raw);
    const base =
      perMin != null
        ? `Rate limited by TokenRouter — your plan is ${perMin} requests/minute.`
        : "Rate limited by TokenRouter — too many requests in this window.";
    return {
      status: "failed",
      summary: base,
      detail: retryAfterMs > 0 ? `Retry in ${Math.round(retryAfterMs / 1000)}s (the server said so).` : "One moment and the governor will take it itself; manual retry is only worth it if this repeats.",
      retryAfterMs: retryAfterMs || 60_000,
      raw,
    };
  }

  if (lower.includes("concurrency")) {
    return {
      status: "failed",
      summary: `${model} — the gateway is at its concurrency ceiling right now.`,
      detail: "Not a rate limit you can wait out: a hard concurrent-slots refusal. Re-probe in a minute; if it persists, the plan is too small for the council's pace, not misconfigured.",
      retryAfterMs: 60_000,
      raw,
    };
  }

  // Wrong endpoint. This is the one case where the badge is a lie if we just
  // report "failed": the model is fine, the wire is wrong.
  if (
    lower.includes("not supported in the") ||
    (lower.includes("/v1/chat/completions") && lower.includes("v1/responses")) ||
    (lower.includes("use the v1/responses endpoint") && lower.includes("instead"))
  ) {
    return {
      status: "unsupported",
      summary: `${model} lives on a different endpoint.`,
      detail: "This model answers on /v1/responses, not /v1/chat/completions. Point the seat at the Responses API and it should answer on the next probe.",
      retryAfterMs: 0,
      suggestEndpoint: "responses",
      raw,
    };
  }

  // Name errors. TokenRouter 404s when an id is not on the account, and it
  // says so in the same shape.
  if (/model_not_found|unknown model|no such model|does not exist|invalid model/.test(lower)) {
    return {
      status: "failed",
      summary: `${model} — model id not recognised.`,
      detail: "Check the exact id in the TokenRouter catalogue, then again on the key's allowed list. It is usually the suffix (e.g. -preview) or the key's group entitlements.",
      retryAfterMs: 0,
      raw,
    };
  }

  // TokenRouter's own access-control message: "This token has no access to
  // model X". Distinct from a missing id — the model exists in the catalogue
  // but the key is not entitled to it. Needs a billing/permissions action at
  // tokenrouter.com, not a typo fix here.
  if (lower.includes("has no access to model") || lower.includes("no access to model") || lower.includes("token has no access")) {
    return {
      status: "failed",
      summary: `${model} — this key is not entitled to that model.`,
      detail: "Go to tokenrouter.com → API Keys → edit the key → enable this model under Permissions. If the model is not in your plan, you may need to add it first under Models.",
      retryAfterMs: 0,
      raw,
    };
  }

  // Authentication / authorization. The 401 body carries its own reason; keep
  // the prefix so "bad key" and "key disabled for model" are told apart.
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("invalid api key")) {
    return {
      status: "failed",
      summary: `${model} — the key was refused.`,
      detail: "Re-paste the key in Settings; if it still fails, it is disabled at TokenRouter for this model, not mistyped here.",
      retryAfterMs: 0,
      raw,
    };
  }

  // A reasoning model asked for anything can legitimately sit thinking for a
  // minute and a half. Longer than that is the model hanging, which is what
  // the probe's timeout is for.
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: "failed",
      summary: `${model} — gave no answer inside 90s.`,
      detail: "Reasoning models do legitimately think this long on a cold start. Retest later; if it repeats, the model is genuinely unreachable, not slow to warm.",
      retryAfterMs: 0,
      raw,
    };
  }

  // An empty body after a 200 is a routing lie — the model answered the
  // transport ack but not the question. Only TokenRouter does this.
  if (lower.includes("returned nothing") || lower.includes("empty response")) {
    return {
      status: "failed",
      summary: `${model} — the gateway answered but gave nothing back.`,
      detail: "Almost always the router, not the model: it is listed as available but its backing route returned an empty reply. TokenRouter usually fixes it within minutes.",
      retryAfterMs: 30_000,
      raw,
    };
  }

  // Gateway overloaded admits what it is.
  if (lower.includes("overload") || lower.includes("capacity") || lower.includes("503") || lower.includes("502")) {
    return {
      status: "failed",
      summary: `${model} — TokenRouter is overloaded.`,
      detail: "Not your key and not the model: the gateway itself said so. Wait and re-probe; this one costs nothing on our side to retry.",
      retryAfterMs: 30_000,
      raw,
    };
  }

  return {
    status: "failed",
    summary: `${model} failed.`,
    detail: "The provider did not categorise this error. The raw reason is on the panel row; copy it into a bug report if this keeps happening.",
    retryAfterMs: 0,
    raw,
  };
}

/** Parses a bare `Retry-After: 12` out of a 429 body, in ms, or 0. */
function parseRetryAfter(raw: string): number {
  const m = raw.match(/retry-after[:\s]+(\d{1,3})/i);
  if (!m) return 0;
  const secs = parseInt(m[1], 10);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 0;
}

/**
 * Renders the verdict for a toast. Short, single-line, and actionable: the
 * point is "I know what to do next", not "here is the stack trace".
 */
export function probeToastText(report: ProbeReport): { title: string; body: string } {
  if (report.status === "ok") {
    return { title: "Model connected", body: report.summary };
  }
  if (report.status === "unsupported") {
    return { title: "Wrong endpoint", body: report.summary };
  }
  return {
    title: report.summary,
    body: report.detail ?? (report.raw || report.summary),
  };
}
