/** Disposable, isolated, one-use sandboxes prepared during AI reasoning.
 * Each solver has its own microVM; no candidate shares a mutable filesystem.
 * When ready slots expire or startup fails, the existing cold path is used.
 */
export function createE2BWarmPool({create, destroy, idleMs = 75_000, onEvent = () => {}}) {
  if (typeof create !== "function" || typeof destroy !== "function") throw new TypeError("create and destroy required");
  if (!Number.isSafeInteger(idleMs) || idleMs < 1000 || idleMs > 180_000)
    throw new RangeError("Warm idle lifetime must be 1-180 seconds");
  const slots = new Map();
  let closed = false;
  function emit(type, meta) {
    Promise.resolve().then(() => onEvent(type, meta)).catch(() => {});
  }
  function prewarm(letters) {
    if (closed || slots.size) throw new Error("Warm pool has already started or closed");
    const unique = [...new Set(letters)].slice(0, 4);
    for (const letter of unique) {
      const slot = {letter, state: "starting", lease: null, timer: null, promise: null};
      slots.set(letter, slot);
      slot.promise = Promise.resolve().then(() => create(letter)).then(async lease => {
        if (closed || slot.state !== "starting") {
          await destroy(lease);
          return null;
        }
        slot.lease = lease;
        slot.state = "ready";
        slot.timer = setTimeout(() => {
          if (slot.state !== "ready") return;
          slot.state = "expired";
          slots.delete(letter);
          emit("expired", {letter});
          void destroy(lease).catch(() => {});
        }, idleMs);
        slot.timer.unref?.();
        emit("ready", {letter, sandboxId: lease.sandbox?.sandboxId ?? null});
        return lease;
      }).catch(error => {
        slot.state = "failed";
        slots.delete(letter);
        emit("failed", {letter, reason: String(error).slice(0,160)});
        return null;
      });
    }
  }
  async function take(letter) {
    const slot = slots.get(letter);
    if (!slot || closed) return null;
    await slot.promise;
    if (closed || slot.state !== "ready") return null;
    slot.state = "leased";
    if (slot.timer) clearTimeout(slot.timer);
    slots.delete(letter);
    emit("reused", {letter, sandboxId: slot.lease?.sandbox?.sandboxId ?? null});
    return slot.lease;
  }
  async function close() {
    if (closed) return;
    closed = true;
    const all = [...slots.values()];
    // Do not allow a late E2B create to become an orphan after job failure.
    await Promise.allSettled(all.map(s => s.promise));
    await Promise.allSettled(all.map(async slot => {
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.state === "ready" && slot.lease) {
        slot.state = "disposed";
        await destroy(slot.lease);
        emit("disposed", {letter: slot.letter});
      }
    }));
    slots.clear();
  }
  return {prewarm, take, close, snapshot: () => ({
    closed, slots: [...slots.values()].map(s => ({letter: s.letter, state: s.state}))
  })};
}
