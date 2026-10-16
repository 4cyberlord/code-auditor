/** Process-local capacity gate for E2B's Hobby tier.
 * It includes READY standby sandboxes, not just commands currently running.
 * A separate distributed gate is required if several workers use one E2B key.
 */
export function createSandboxCapacity(limit = 8) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid E2B capacity");
  let active = 0;
  const pending = [];
  function permit() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiting = pending.shift();
      if (waiting) waiting(permit());
      else active -= 1;
    };
  }
  return {
    acquire() {
      if (active < limit) {
        active += 1;
        return Promise.resolve(permit());
      }
      return new Promise(resolve => pending.push(resolve));
    },
    snapshot() { return {active, waiting: pending.length, limit}; },
  };
}

/** Prevent unexpected quota consumption when a worker is misconfigured. */
export function hobbyWorkerLimit(raw, fallback = 8) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 8) : fallback;
}

/** Leave at least two slots for reference checks / compulsory cold executions.
 * Prevents idle standby microVMs from deadlocking a tiny Hobby worker limit.
 */
export function standbyBudget(snapshot, requested, reserve = 2) {
  const total = Math.max(0,Math.trunc(Number(snapshot?.limit) || 0));
  const used = Math.max(0,Math.trunc(Number(snapshot?.active) || 0));
  const required = Math.max(1,Math.trunc(Number(reserve) || 2));
  const wanted = Math.max(0,Math.trunc(Number(requested) || 0));
  return Math.max(0,Math.min(wanted,total-used-required));
}
