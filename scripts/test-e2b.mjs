#!/usr/bin/env node
/**
 * Does an E2B sandbox actually have a C++ toolchain, and can it measure one?
 *
 *   node scripts/test-e2b.mjs
 *
 * Worth asking before the Council depends on it. E2B's code-interpreter template
 * is built for Python and JavaScript; C++ is the language this project puts
 * first, and `/usr/bin/time` is what every memory number ultimately comes from.
 * If either is missing, the sandbox will happily accept a C++ candidate and then
 * report it as a failure that has nothing to do with the candidate's code.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

for (const file of [".development.env", ".env"]) {
  const full = path.join(process.cwd(), file);
  if (!existsSync(full)) continue;
  for (const raw of readFileSync(full, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

if (!process.env.E2B_API_KEY?.trim()) {
  console.error("E2B_API_KEY is missing. Add it to .development.env and run again.");
  process.exit(2);
}

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const PROBE = String.raw`
echo "--- toolchain"
for tool in c++ g++ gcc cc python3 node rustc go java /usr/bin/time; do
  if command -v "$tool" >/dev/null 2>&1; then echo "ok      $tool -> $(command -v "$tool")"; else echo "MISSING $tool"; fi
done

echo "--- c++ compile and run"
tmp="$(mktemp -d)"; cd "$tmp"
cat > main.cpp <<'CPP'
#include <cstdio>
#include <vector>
int main() {
  std::vector<int> v;
  for (int i = 0; i < 1000000; i++) v.push_back(i);
  long long sum = 0;
  for (int x : v) sum += x;
  printf("PASS sum=%lld\n", sum);
  return 0;
}
CPP
if c++ -std=c++20 -O2 main.cpp -o prog 2>compile.log; then
  echo "compiled with $(c++ --version | head -1)"
  if command -v /usr/bin/time >/dev/null 2>&1; then
    /usr/bin/time -f 'CA_METRICS elapsed_s=%e maxrss_kb=%M' ./prog
  else
    echo "no /usr/bin/time — memory cannot be measured here"
    ./prog
  fi
else
  echo "COMPILE FAILED:"; cat compile.log
fi
`;

const started = Date.now();
console.log("Creating an E2B sandbox…");
const { Sandbox } = await import("@e2b/code-interpreter");
const sandbox = await Sandbox.create({ timeoutMs: 120_000, metadata: { app: "code-auditor", purpose: "toolchain-probe" } });
console.log(dim(`  sandbox ${sandbox.sandboxId} up in ${((Date.now() - started) / 1000).toFixed(1)}s`));

try {
  const res = await sandbox.commands.run(`bash -lc ${JSON.stringify(PROBE)}`, { timeoutMs: 90_000 });
  const text = `${res.stdout || ""}\n${res.stderr || ""}`;
  console.log(text.trim());

  const hasCpp = /ok\s+c\+\+/.test(text);
  const hasTime = /ok\s+\/usr\/bin\/time/.test(text);
  const ran = /PASS sum=499999500000/.test(text);
  const mem = /maxrss_kb=(\d+)/.exec(text);

  console.log("\nVerdict");
  console.log(`  C++ compiler       ${hasCpp ? g("present") : r("MISSING")}`);
  console.log(`  program ran right  ${ran ? g("yes") : r("no")}`);
  console.log(`  /usr/bin/time      ${hasTime ? g("present") : r("MISSING — no memory numbers")}`);
  if (mem) console.log(`  peak memory        ${(Number(mem[1]) / 1024).toFixed(1)} MB`);
  console.log(
    hasCpp && ran
      ? g("\nE2B can run the Council's C++ benchmarks.\n")
      : r("\nE2B cannot run C++ as-is — it needs a custom template with build-essential.\n")
  );
  process.exit(hasCpp && ran ? 0 : 1);
} finally {
  await sandbox.kill().catch(() => {});
  console.log(dim("sandbox killed"));
}
