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
const end = src.indexOf("async function runRemoteCode(");
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
check("a configured repo benchmarks on Actions", resolveBenchmarkBackend({}, REPO), "actions");
check("the alternate env var works too", resolveBenchmarkBackend({}, { CODE_AUDITOR_GITHUB_REPOSITORY: "a/b" }), "actions");

console.log("\n2. nothing to dispatch to means off, not a broken run");
// Claiming "actions" with no repo would dispatch nowhere and report a failure
// per candidate. Off is the honest state.
check("no repo anywhere", resolveBenchmarkBackend({}, {}), "off");
check("explicitly asking for Actions without a repo", resolveBenchmarkBackend({ benchmarkBackend: "actions" }, {}), "off");

console.log("\n3. an explicit choice is obeyed");
check("codespaces", resolveBenchmarkBackend({ benchmarkBackend: "codespaces" }, REPO), "codespaces");
check("off", resolveBenchmarkBackend({ benchmarkBackend: "off" }, REPO), "off");
check("actions", resolveBenchmarkBackend({ benchmarkBackend: "actions" }, REPO), "actions");
check("case and spacing are forgiven", resolveBenchmarkBackend({ benchmarkBackend: " Codespaces " }, REPO), "codespaces");

console.log("\n4. settings saved before this existed keep working");
// Turning Codespaces on once must not silently become Actions on next launch.
check("legacy flag honoured", resolveBenchmarkBackend({ codespacesBenchmark: true }, REPO), "codespaces");
check("legacy flag off falls to the default", resolveBenchmarkBackend({ codespacesBenchmark: false }, REPO), "actions");
// An explicit choice outranks the legacy flag.
check("explicit beats legacy", resolveBenchmarkBackend({ benchmarkBackend: "actions", codespacesBenchmark: true }, REPO), "actions");

console.log("\n5. junk falls back rather than throwing");
check("nonsense backend", resolveBenchmarkBackend({ benchmarkBackend: "banana" }, REPO), "actions");
check("empty string", resolveBenchmarkBackend({ benchmarkBackend: "" }, REPO), "actions");
check("undefined settings", resolveBenchmarkBackend(undefined, REPO), "actions");

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall backend checks passed\n");
process.exit(fail ? 1 : 0);
