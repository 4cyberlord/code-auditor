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

const { buildProvidedHarness } = await import("../src/lib/providedCaseHarness.ts");
const { spliceSuite } = await import("../src/lib/council.ts");

const addQ = ["Add", "Example 1:", "Input: a = 2, b = 3", "Output: 5"].join("\n");
const listQ = ["Reverse", "Example 1:", "Input: head = [1,2]", "Output: [2,1]"].join("\n");

const cases = [
  { name: "python-scalar", language: "python", question: addQ,
    good: "def add(a, b):\n    return a + b", bad: "def add(a, b):\n    return a - b", ext: "py" },
  { name: "cpp-scalar", language: "cpp", question: addQ,
    good: "int add(int a, int b) { return a + b; }", bad: "int add(int a, int b) { return a - b; }",
    ext: "cpp", compile: ["c++", "-std=c++23", "-O1"] },
  { name: "rust-scalar", language: "rust", question: addQ,
    good: "pub fn add(a: i64, b: i64) -> i64 { a + b }", bad: "pub fn add(a: i64, b: i64) -> i64 { a - b }",
    ext: "rs", compile: ["rustc", "-O"] },
  { name: "python-node", language: "python", question: listQ,
    good: "class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val=val; self.next=next\nclass Solution:\n    def reverse(self, head):\n        prev=None\n        while head:\n            nxt=head.next; head.next=prev; prev=head; head=nxt\n        return prev",
    bad: "class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val=val; self.next=next\nclass Solution:\n    def reverse(self, head):\n        return head",
    ext: "py" },
];

const template = process.env.CODE_AUDITOR_E2B_TEMPLATE?.trim();
const { Sandbox } = await import("@e2b/code-interpreter");
const opts = { timeoutMs: 240_000, metadata: { app: "code-editor", purpose: "harness-certification" } };
const sandbox = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
const shellSingle = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

let failures = 0;
try {
  for (const testCase of cases) {
    const suite = buildProvidedHarness(testCase.question, testCase.language, testCase.good);
    if (!suite) { console.log(`FAIL ${testCase.name}: suite did not build`); failures += 1; continue; }
    for (const [variant, expectFail] of [["good", false], ["bad", true]]) {
      const program = spliceSuite(suite, testCase[variant]);
      const b64 = Buffer.from(program, "utf8").toString("base64");
      const file = `/tmp/cert-${testCase.name}-${variant}.${testCase.ext}`;
      const bin = `/tmp/cert-${testCase.name}-${variant}.bin`;
      const compile = testCase.compile ? `${testCase.compile.join(" ")} ${file} -o ${bin} && ` : "";
      const command = `echo ${b64} | base64 -d > ${file} && ${compile}${testCase.language === "python" ? `python3 ${file}` : bin}`;
      // The SDK throws on a non-zero exit; the bad candidate is expected to.
      let result;
      try {
        result = await sandbox.commands.run(`bash -lc ${shellSingle(command)}`, { timeoutMs: 90_000 });
      } catch (error) {
        result = error?.result || { exitCode: 1, stdout: "", stderr: String(error) };
      }
      const out = `${result.stdout || ""}\n${result.stderr || ""}`;
      const failedExit = result.exitCode !== 0;
      const ok = expectFail ? failedExit && /FAIL provided_/.test(out) : !failedExit && /CA_DONE/.test(out);
      console.log(`${ok ? "PASS" : "FAIL"} ${testCase.name} ${variant}`);
      if (!ok) { console.log(out.slice(0, 500)); failures += 1; }
    }
  }
} finally {
  await sandbox.kill().catch(() => {});
}

console.log(failures ? `\n${failures} certification case(s) failed in E2B.` : "\nMatrix slice passed inside E2B.");
process.exit(failures ? 1 : 0);
