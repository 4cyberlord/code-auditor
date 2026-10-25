/**
 * Certification matrix: every certified template must pass a correct candidate
 * and fail a deliberately wrong one in the real toolchain it will judge with.
 * A template without an entry here does not deserve `certified: true`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { buildProvidedHarness, providedCaseEvidence } from "../src/lib/providedCaseHarness.ts";
import { spliceSuite } from "../src/lib/council.ts";
import { HARNESS_REGISTRY } from "../src/lib/harnessRegistry.ts";

import { CERT_CASES as cases, type CertCase } from "./harnessCertificationCases.ts";

function execute(testCase: CertCase, program: string, runner: "python" | "cpp" | "rust" = testCase.language) {
  const file = `/tmp/cert-${testCase.template.replace(/\W/g, "-")}-${testCase.language}.${testCase.language === "cpp" ? "cpp" : testCase.language === "rust" ? "rs" : "py"}`;
  writeFileSync(file, program);
  if (runner === "python") return spawnSync("python3", [file]);
  const binary = file + ".bin";
  const argv = runner === "cpp"
    ? ["-std=c++23", "-O1", file, "-o", binary]
    : ["-O", file, "-o", binary];
  const built = spawnSync(runner === "cpp" ? "c++" : "rustc", argv);
  assert.equal(built.status, 0, testCase.template + " failed to compile: " + String(built.stderr));
  return spawnSync(binary);
}

const covered = new Set(cases.map((testCase) => testCase.template));
assert.equal(covered.size, HARNESS_REGISTRY.filter((entry) => entry).length);

for (const testCase of cases) {
  if (testCase.language !== "python") {
    const tool = testCase.language === "cpp" ? "c++" : "rustc";
    if (spawnSync(tool, ["--version"]).status !== 0) {
      assert.ok(!process.env.REQUIRE_TOOLCHAINS, testCase.template + " skipped without " + tool);
      console.log("SKIP", testCase.template);
      continue;
    }
  }
  const suite = buildProvidedHarness(testCase.question, testCase.language, testCase.good);
  assert.ok(suite, testCase.template + " did not build");
  assert.equal(suite.templateId, testCase.template);
  if (testCase.minCases) assert.ok(suite.providedCaseCount >= testCase.minCases, testCase.template + " lost fixtures");
  const required = suite.providedCaseCount;
  const runner = (suite.runnerLanguage || "python") as "python" | "cpp" | "rust";
  const goodRun = execute(testCase, spliceSuite(suite, testCase.good) ?? "", runner);
  assert.equal(goodRun.status, 0, testCase.template + " good candidate did not exit cleanly");
  const goodEvidence = providedCaseEvidence(String(goodRun.stdout), required);
  assert.ok(goodEvidence.complete, testCase.template + " good evidence incomplete");
  assert.equal(goodEvidence.failed, 0, testCase.template + " rejected a correct answer");
  assert.equal(goodEvidence.passed, required, testCase.template + " skipped fixtures");
  const badRun = execute(testCase, spliceSuite(suite, testCase.bad) ?? "", runner);
  assert.notEqual(badRun.status, 0, testCase.template + " bad candidate exited cleanly");
  const badEvidence = providedCaseEvidence(String(badRun.stdout), required);
  assert.ok(badEvidence.complete, testCase.template + " bad evidence incomplete");
  assert.ok(badEvidence.failed >= 1, testCase.template + " accepted a wrong answer");
}

for (const template of HARNESS_REGISTRY.filter((entry) => entry.certified)) {
  assert.ok(covered.has(template.id), template.id + " is certified without a case");
}
console.log("PASS: every certified template passes good and fails bad code");
