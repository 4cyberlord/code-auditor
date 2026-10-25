#!/usr/bin/env node
/**
 * Run a slice of the certification matrix inside a real E2B sandbox.
 * Proves the harness drivers compile and discriminate under the production
 * toolchain, not just on a CI runner.
 *
 *   node scripts/certify-e2b.mjs
 */
import "./lib/config.mjs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

for (const file of [".development.env", ".env"]) {
  const full = path.join(process.cwd(), file);
  if (!existsSync(full)) continue;
  for (const raw of readFileSync(full, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!m || process.env[m[1]]) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

if (!process.env.E2B_API_KEY?.trim()) {
  console.error("E2B_API_KEY is missing.");
  process.exit(2);
}

const { buildProvidedHarness, providedCaseEvidence } = await import("../src/lib/providedCaseHarness.ts");
const { spliceSuite } = await import("../src/lib/council.ts");

const { CERT_CASES } = await import("../tests/harnessCertificationCases.ts");
const cases = CERT_CASES.map((testCase) => ({
  ...testCase,
  ext: testCase.ext || (testCase.language === "cpp" ? "cpp" : testCase.language === "rust" ? "rs" : "py"),
  compile: testCase.compile || (testCase.language === "cpp" ? ["c++", "-std=c++23", "-O1"]
    : testCase.language === "rust" ? ["rustc", "-O"] : null),
}));

const template = process.env.CODE_AUDITOR_E2B_TEMPLATE?.trim();
const { Sandbox } = await import("@e2b/code-interpreter");
const opts = { timeoutMs: 240_000, metadata: { app: "code-editor", purpose: "harness-certification" } };
const sandbox = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
const shellSingle = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

let failures = 0;
let available = "";
try {
  const probe = await sandbox.commands.run("bash -lc 'command -v c++ || true; command -v rustc || true'", { timeoutMs: 20_000 });
  available = String(probe.stdout || "");
  const has = (tool) => available.split("\n").some((line) => line.trim().endsWith("/" + tool));
  if (!has("rustc") && !template) {
    console.log("rustc missing — installing a minimal toolchain in the sandbox (no pinned template set)");
    await sandbox.commands.run(
      "bash -lc 'curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/tmp/rustup.log 2>&1 || true'",
      { timeoutMs: 180_000 }
    ).catch(() => {});
    const again = await sandbox.commands.run("bash -lc 'command -v rustc || true'", { timeoutMs: 15_000 });
    if (String(again.stdout || "").trim()) available += "\n" + String(again.stdout).trim();
  }
  for (const tool of ["c++", "rustc"]) {
    if (!has(tool)) {
      console.log(`MISSING ${tool} in the sandbox`);
      if (process.env.ALLOW_PARTIAL_E2B !== "1") failures += 1;
    }
  }
  for (const testCase of cases) {
    if (testCase.compile && !available.split("\n").some((line) => line.trim().endsWith("/" + testCase.compile[0]))) continue;
    const suite = buildProvidedHarness(testCase.question, testCase.language, testCase.good);
    if (!suite) { console.log(`FAIL ${testCase.name}: suite did not build`); failures += 1; continue; }
    for (const [variant, expectFail] of [["good", false], ["bad", true]]) {
      const program = spliceSuite(suite, testCase[variant]);
      const b64 = Buffer.from(program, "utf8").toString("base64");
      const file = `/tmp/cert-${testCase.name}-${variant}.${testCase.ext}`;
      const bin = `/tmp/cert-${testCase.name}-${variant}.bin`;
      const compile = testCase.compile ? `${testCase.compile.join(" ")} ${file} -o ${bin} && ` : "";
      const command = `export PATH="$HOME/.cargo/bin:$PATH"; echo ${b64} | base64 -d > ${file} && ${compile}${testCase.language === "python" ? `python3 ${file}` : bin}`;
      // The SDK throws on a non-zero exit; the bad candidate is expected to.
      let result;
      try {
        result = await sandbox.commands.run(`bash -lc ${shellSingle(command)}`, { timeoutMs: 90_000 });
      } catch (error) {
        result = error?.result || { exitCode: 1, stdout: "", stderr: String(error) };
      }
      const out = `${result.stdout || ""}\n${result.stderr || ""}`;
      const failedExit = result.exitCode !== 0;
      const evidence = providedCaseEvidence(out, suite.providedCaseCount);
      const ok = expectFail
        ? failedExit && evidence.complete && evidence.failed >= 1
        : !failedExit && evidence.complete && evidence.failed === 0 && evidence.passed === suite.providedCaseCount;
      console.log(`${ok ? "PASS" : "FAIL"} ${testCase.name} ${variant}`);
      if (!ok) { console.log(out.slice(0, 500)); failures += 1; }
    }
  }
} finally {
  await sandbox.kill().catch(() => {});
}

console.log(failures ? `\n${failures} certification case(s) failed in E2B.` : "\nMatrix slice passed inside E2B.");
process.exit(failures ? 1 : 0);
