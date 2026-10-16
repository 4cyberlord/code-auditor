/** Optional cross-language trace protocol.
 * A harness may emit: CA_DIFF_CASE {"id":"zero","input":[0],"actual":0}
 * This is corroborating evidence only, NEVER a replacement for independent
 * reference tests or the E2B winner gate. Missing traces are inconclusive.
 */
const PREFIX = "CA_DIFF_CASE ";
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key)+":"+canonical(value[key])).join(",") + "}";
}
export function extractDifferentialTrace(stdout, limit=16) {
  const out = new Map();
  for (const line of String(stdout||"").split(/\r?\n/)) {
    if (!line.startsWith(PREFIX) || out.size >= limit) continue;
    const raw=line.slice(PREFIX.length);
    if (raw.length > 4096) continue;
    try {
      const parsed=JSON.parse(raw);
      if (!parsed || typeof parsed.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.id) ||
          !Object.hasOwn(parsed,"input") || !Object.hasOwn(parsed,"actual") ||
          out.has(parsed.id)) continue;
      out.set(parsed.id,{input:canonical(parsed.input),actual:canonical(parsed.actual)});
    } catch { /* An invalid trace is not an E2B verification failure. */ }
  }
  return out;
}
export function compareDifferentialTraces(sourceStdout, targetStdout) {
  const source=extractDifferentialTrace(sourceStdout);
  const target=extractDifferentialTrace(targetStdout);
  if (!source.size || !target.size) return {status:"unavailable",sharedCases:0,mismatches:[],
    caveat:"No shared language-neutral execution trace. Independent harness tests remain authoritative."};
  let shared=0;
  const mismatches=[];
  for (const [id,reference] of source) {
    const candidate=target.get(id);
    if (!candidate || candidate.input !== reference.input) continue;
    shared++;
    if (candidate.actual !== reference.actual) mismatches.push(id);
  }
  return {status:!shared?"incomparable":mismatches.length?"disagreement":"corroborated",
    sharedCases:shared,mismatches,
    caveat:"A matching trace does not establish full semantic equivalence or Big-O correctness."};
}
export function sharedDifferentialFixtures(stdout) {
  // The source harness may expose a few JSON-serializable fixtures. Never put
  // raw solution code or arbitrary runner logs into translation instructions.
  const trace=extractDifferentialTrace(stdout,8);
  return [...trace.entries()].map(([id,item])=>({id,input:JSON.parse(item.input)}));
}
