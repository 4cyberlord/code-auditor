/** Bounded concurrency with stable result order and no abandoned in-flight writes. */
export async function parallelMap(items, concurrency, worker) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  if (typeof worker !== "function") throw new TypeError("worker must be a function");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError("concurrency must be a positive integer");
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  let stopped = false;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  });
  const settled = await Promise.allSettled(runners);
  const failed = settled.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}
/** Allow one-worker rollback and cap provider consumption per worker. */
export function workerConcurrency(raw, fallback = 4, max = 9) {
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) && value >= 1
    ? Math.min(value, max) : fallback;
}
