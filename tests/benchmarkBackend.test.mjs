// The resolution rule, extracted verbatim from cloud-worker.mjs so the policy
// can be tested without booting the worker's whole dependency graph.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Resolved from this file, not from the working directory: a test that only
// passes when run from the repo root is a test that fails in CI for a reason
// that has nothing to do with the code.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, "..", "scripts", "cloud-worker.mjs"), "utf8");
const start = src.indexOf("export function resolveBenchmarkBackend");
const end = src.indexOf("async function runE2BCode(");
const mod = src.slice(start, end).replace(/export function/g, "function");
const { resolveBenchmarkBackend } = await import(
  "data:text/javascript," + encodeURIComponent(mod + "\nexport { resolveBenchmarkBackend };")
);

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${got}, want ${want}`}`);
  if (!ok) fail++;
};

const REPO = { GITHUB_REPOSITORY: "cyberlord/code-auditor" };

console.log("\n1. Actions is the default");
// Having a repo configured is not a request to use it. Actions used to switch
// itself on whenever GITHUB_REPOSITORY existed, which ran every passing
// candidate a second time purely to time it -- while the sandbox that had just
// run it was already reporting elapsed time and peak memory from the same
// metrics script. Whatever ran the code measures it, unless you say otherwise.
check("a configured repo is not a request to use it", resolveBenchmarkBackend({}, REPO), "off");
check("nor is the alternate env var", resolveBenchmarkBackend({}, { CODE_AUDITOR_GITHUB_REPOSITORY: "a/b" }), "off");

console.log("\n2. nothing to dispatch to means off, not a broken run");
// Claiming "actions" with no repo would dispatch nowhere and report a failure
// per candidate. Off is the honest state.
check("no repo anywhere", resolveBenchmarkBackend({}, {}), "off");
check("explicitly asking for Actions without a repo", resolveBenchmarkBackend({ benchmarkBackend: "actions" }, {}), "off");

console.log("\n3. an explicit choice is obeyed");
check("off", resolveBenchmarkBackend({ benchmarkBackend: "off" }, REPO), "off");
check("actions", resolveBenchmarkBackend({ benchmarkBackend: "actions" }, REPO), "actions");
check("case and spacing are forgiven", resolveBenchmarkBackend({ benchmarkBackend: " Actions " }, REPO), "actions");

console.log("\n4. old Codespaces settings are retired");
check("a retired backend name does not smuggle Actions back in", resolveBenchmarkBackend({ benchmarkBackend: "codespaces" }, REPO), "off");
check("legacy codespaces flag is ignored", resolveBenchmarkBackend({ codespacesBenchmark: true }, REPO), "off");

console.log("\n5. junk falls back rather than throwing");
// Junk must never be read as consent to spend runner minutes.
check("nonsense backend", resolveBenchmarkBackend({ benchmarkBackend: "banana" }, REPO), "off");
check("empty string", resolveBenchmarkBackend({ benchmarkBackend: "" }, REPO), "off");
check("undefined settings", resolveBenchmarkBackend(undefined, REPO), "off");
// And asking for it plainly still works.
check("asking for Actions is honoured", resolveBenchmarkBackend({ benchmarkBackend: "actions" }, REPO), "actions");


// Phase 2: the execution provider may never silently switch to host execution.
// Extract the real production resolver, as with resolveBenchmarkBackend above.
const execStart = src.indexOf("function executionProvider(settings)");
const execEnd = src.indexOf("async function runVerification(", execStart);
if (execStart < 0 || execEnd < 0) throw new Error("Execution provider function not found");
const execModule = src.slice(execStart, execEnd);
const { executionProvider } = await import(
  "data:text/javascript," + encodeURIComponent(execModule + "\nexport { executionProvider };")
);

console.log("\n6. E2B-first sandbox selection and fail-closed policy");
check("missing settings still selects E2B", executionProvider({}), "e2b");
check("missing key does not change the default", executionProvider({ executionProvider: "" }), "e2b");
check("local requires explicit selection", executionProvider({ executionProvider: "local" }), "local");
check("E2B explicitly selected", executionProvider({ executionProvider: "e2b" }), "e2b");
check("whitespace and casing normalize", executionProvider({ executionProvider: " E2B " }), "e2b");
let rejected = false;
try { executionProvider({ executionProvider: "docker" }); } catch { rejected = true; }
check("unexpected provider is refused", rejected, true);

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall backend checks passed\n");
process.exit(fail ? 1 : 0);
