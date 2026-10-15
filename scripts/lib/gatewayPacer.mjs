/**
 * Request-start pacing for model gateways.
 *
 * Default is one conservative global lane per worker, preserving existing
 * account-wide rate-limit behavior. Operators who have confirmed that their
 * gateway quotas are per-model may opt into independent lanes with
 * CODE_AUDITOR_TOKENROUTER_PACING_SCOPE=per_model.
 *
 * This only gates start times; calls run concurrently after their turn.
 * Upstream 429 responses still use the existing retry-after/backoff handling.
 */
export function gatewayPacingScope(value) {
  return value === "per_model" ? "per_model" : "global";
}

export function createGatewayPacer({
  scope = "global",
  minDelayMs = 13_000,
  jitterMs = 1_500,
  now = () => Date.now(),
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  const mode = gatewayPacingScope(scope);
  const interval = Math.max(0, Number.isFinite(Number(minDelayMs)) ? Number(minDelayMs) : 13_000);
  const jitter = Math.max(0, Number.isFinite(Number(jitterMs)) ? Number(jitterMs) : 1_500);
  const nextAt = new Map();
  const pending = new Map();

  return async function waitForTurn(model = "") {
    const route = mode === "per_model" && String(model).trim() ? String(model).trim() : "__all__";
    const previous = pending.get(route) || Promise.resolve();
    const task = previous.then(async () => {
      const waitMs = Math.max(0, (nextAt.get(route) || 0) - now());
      if (waitMs > 0) await delay(waitMs);
      const noise = jitter > 0 ? Math.floor(random() * jitter) : 0;
      nextAt.set(route, now() + interval + noise);
    });
    pending.set(route, task.catch(() => {}));
    await task;
  };
}
