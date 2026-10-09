import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
const script=await readFile("scripts/run-benchmark-container.sh","utf8");
for (const required of [
  "--network none","--read-only","--cap-drop ALL",
  "--security-opt no-new-privileges","--pids-limit 64",
  "--memory 512m","--user 1000:1000",
  "target=/workspace,readonly","target=/runner/run-benchmark.mjs,readonly",
  "COUNCIL_BENCHMARK_ROOT=/workspace",
]) assert.ok(script.includes(required),`Missing container constraint: ${required}`);
assert.ok(!script.includes("--privileged"));
console.log("PASS: benchmark container launcher has expected minimum isolation flags");
