/** Disposable, one-use, isolated E2B sandboxes for a single solve job.
 * A cleanup failure is security-relevant and must NEVER disappear silently.
 */
export function createE2BWarmPool({create,destroy,idleMs=75_000,onEvent=()=>{}}) {
  if (typeof create !== "function" || typeof destroy !== "function")
    throw new TypeError("create and destroy required");
  if (!Number.isSafeInteger(idleMs) || idleMs < 1000 || idleMs > 180_000)
    throw new RangeError("Warm idle lifetime must be 1-180 seconds");
  const slots=new Map();
  const retirements=new Set();
  const cleanupFailures=[];
  let closed=false, closing=null;
  function emit(type,meta) {
    Promise.resolve().then(()=>onEvent(type,meta)).catch(()=>{});
  }
  function retire(lease,letter,why) {
    let task;
    task=Promise.resolve().then(()=>destroy(lease))
      .then(()=>emit("disposed",{letter,why}))
      .catch(error=>{
        const reason=String(error).slice(0,160);
        cleanupFailures.push(letter+": "+reason);
        emit("cleanup_failed",{letter,why,reason});
      })
      .finally(()=>retirements.delete(task));
    retirements.add(task);
    return task;
  }
  function prewarm(letters) {
    if (closed || slots.size) throw new Error("Warm pool has already started or closed");
    const unique=[...new Set(letters)].slice(0,4);
    for (const letter of unique) {
      const slot={letter,state:"starting",lease:null,readyAt:null,timer:null,promise:null};
      slots.set(letter,slot);
      slot.promise=Promise.resolve().then(()=>create(letter)).then(async lease=>{
        if (closed || slot.state !== "starting") {
          await retire(lease,letter,"late-create-after-close");
          return null;
        }
        slot.lease=lease;
        slot.readyAt=Date.now();
        slot.state="ready";
        slot.timer=setTimeout(()=>{
          if (slot.state !== "ready") return;
          slot.state="expired";
          slots.delete(letter);
          emit("expired",{letter});
          void retire(lease,letter,"idle-expiry");
        },idleMs);
        slot.timer.unref?.();
        emit("ready",{letter,sandboxId:lease.sandbox?.sandboxId??null});
        return lease;
      }).catch(error=>{
        slot.state="failed";
        slots.delete(letter);
        emit("failed",{letter,reason:String(error).slice(0,160)});
        return null;
      });
    }
  }
  async function take(letter) {
    const slot=slots.get(letter);
    if (!slot || closed) return null;
    await slot.promise;
    if (closed || slot.state !== "ready") return null;
    slot.state="leased";
    if (slot.timer) clearTimeout(slot.timer);
    slots.delete(letter);
    slot.lease.warmIdleMs=Math.max(0,Date.now()-slot.readyAt);
    emit("reused",{letter,sandboxId:slot.lease.sandbox?.sandboxId??null,
      warmIdleMs:slot.lease.warmIdleMs});
    return slot.lease;
  }
  function close() {
    if (closing) return closing;
    closing=(async()=>{
      closed=true;
      const all=[...slots.values()];
      await Promise.allSettled(all.map(slot=>slot.promise));
      await Promise.allSettled(all.map(async slot=>{
        if (slot.timer) clearTimeout(slot.timer);
        if (slot.state === "ready" && slot.lease) {
          slot.state="disposed";
          await retire(slot.lease,slot.letter,"job-end");
        }
      }));
      // Expiry cleanup may be in flight even after its slot left the map.
      await Promise.allSettled([...retirements]);
      slots.clear();
      if (cleanupFailures.length)
        throw new Error("E2B standby cleanup failed: "+cleanupFailures.join("; "));
    })();
    return closing;
  }
  return {prewarm,take,close,snapshot:()=>({
    closed,slots:[...slots.values()].map(s=>({letter:s.letter,state:s.state})),
    cleanupFailures:cleanupFailures.length,
  })};
}
