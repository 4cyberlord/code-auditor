#!/usr/bin/env node
/** Explicit E2B Hobby smoke test. Never runs during normal CI/PR processing. */
// Production obtains the E2B credential and template alias from app_config.
// Load that source first so this script exercises the same configuration path
// as the worker, while still permitting explicit environment overrides.
import "./lib/config.mjs";
import { Sandbox } from "e2b";
const key = String(process.env.E2B_API_KEY || "").trim();
const alias = String(process.env.CODE_AUDITOR_E2B_TEMPLATE || "").trim();
if (!key || !alias) {
  console.error("Specify E2B_API_KEY and CODE_AUDITOR_E2B_TEMPLATE for an explicitly built canary image.");
  process.exitCode = 2;
} else {
  let sandbox;
  try {
    sandbox = await Sandbox.create(alias, {
      apiKey: key, timeoutMs: 120_000, allowInternetAccess: false,
      metadata: {app:"council-editor", purpose:"explicit-template-smoke"},
    });
    const cmd = [
      "set +e",
      "python3 --version",
      "c++ --version | head -1",
      "rustc --version",
      "cargo --version",
      "test -x /usr/bin/time || echo MISSING:/usr/bin/time",
      "test -s /etc/council-template-revision || echo MISSING:/etc/council-template-revision",
      "python3 -m pytest --version || echo MISSING:pytest",
      "python3 -m mypy --version || echo MISSING:mypy",
      "radon --version || echo MISSING:radon",
      "ruff --version || echo MISSING:ruff",
      "python3 -c \"import hypothesis; print('hypothesis', hypothesis.__version__)\" || echo MISSING:hypothesis",
      "python3 -c \"import ast; ast.parse('def f(x): return x + 1'); print('python-ast: PASS')\" || echo FAIL:python-ast",
      "printf '%s\\n' 'from hypothesis import given, strategies as st' '' 'def identity(value: int) -> int:' '    return value' '' '@given(st.integers())' 'def test_identity(value: int) -> None:' '    assert identity(value) == value' > test_python_tools.py",
      "python3 -m pytest -q test_python_tools.py || echo FAIL:pytest-execution",
      "python3 -m mypy --strict test_python_tools.py || echo FAIL:mypy-execution",
      "ruff check test_python_tools.py || echo FAIL:ruff-execution",
      "radon cc test_python_tools.py -s || echo FAIL:radon-execution",
    ].join("; ");
    const quote = value => "'" + String(value).replaceAll("'", String.raw`'"'"'`) + "'";
    let result;
    try {
      result = await sandbox.commands.run("bash -lc " + quote(cmd), {timeoutMs:60_000});
    } catch (error) {
      result = error?.result;
    }
    const stdout = String(result?.stdout || "");
    const stderr = String(result?.stderr || "");
    console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    const failures = stdout.split(/\r?\n/).filter((line) => /^(?:MISSING|FAIL):/.test(line));
    if (!result || result.exitCode !== 0 || failures.length) {
      throw new Error("Template smoke failed" + (failures.length ? ": " + failures.join(", ") : " (exit " + (result?.exitCode ?? "unknown") + ")"));
    }
    console.log("PASS: template " + alias + " executed isolated Python validators, AST parsing, C++, Rust and timing tools.");
  } catch(error) {
    console.error("FAIL: "+String(error instanceof Error?error.message:error));
    process.exitCode = 1;
  } finally {
    if (sandbox) {
      try { await sandbox.kill(); }
      catch(error) {
        console.error("FAIL: sandbox cleanup: "+String(error));
        process.exitCode=1;
      }
    }
  }
}
