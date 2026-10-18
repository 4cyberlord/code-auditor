/**
 * Harness Engine V2: question-supplied examples are test evidence, not model output.
 *
 * Only labelled Input/Output pairs are admitted. A deterministic Python driver
 * compiles/runs stdin solutions in Python, C++23 or Rust, or invokes a supported
 * Python function/class API. No fabricated oracle or generated expected value.
 *
 * Unsupported/ambiguous contracts fall back to the independently checked
 * legacy specification harness; the compiler never guesses an answer.
 */

export type ProvidedFixture = {
  id: string;
  input: string;
  output: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  expected?: unknown;
};

export type ProvidedSuite = {
  language: string;
  runnerLanguage: "python";
  source: "provided";
  providedCaseCount: number;
  /** Retained so each candidate can get an adapter for its own callable API. */
  question: string;
  harness: string;
};

const MAX_CASES = 16;
const MAX_SOURCE_CHARS = 6000;
const LABEL = /^\s*(?:sample\s+)?(?:input|output|expected\s+output)\s*:\s*(.*)$/i;
export const MIN_GENERATED_HARNESS_CASES = 8;

function splitTopLevel(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let quoted = "";
  let escaped = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quoted) quoted = "";
    } else if (ch === '"' || ch === "'") quoted = ch;
    else if (ch === "[" || ch === "{" || ch === "(") depth += 1;
    else if (ch === "]" || ch === "}" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      result.push(text.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) return [];
  }
  if (depth !== 0 || quoted) return [];
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}

function literal(text: string): unknown {
  const normalized = text.trim()
    .replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null");
  // Never eval content transcribed from a screenshot.
  return JSON.parse(normalized);
}

function callableInputs(text: string): { args: unknown[]; kwargs: Record<string, unknown> } | null {
  try {
    const segments = splitTopLevel(text);
    if (!segments.length || segments.length > 12) return null;
    const kwargs: Record<string, unknown> = Object.create(null);
    const args: unknown[] = [];
    for (const part of segments) {
      const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([\s\S]+)$/.exec(part);
      if (match) {
        if (Object.hasOwn(kwargs, match[1]) || args.length) return null;
        kwargs[match[1]] = literal(match[2]);
      } else {
        if (Object.keys(kwargs).length) return null;
        args.push(literal(part));
      }
    }
    return { args, kwargs };
  } catch {
    return null;
  }
}

/** Extract only actual labelled sample values from the transcribed question. */
export function extractProvidedFixtures(question: string): ProvidedFixture[] {
  const lines = String(question || "").slice(0, 40_000).split(/\r?\n/);
  const pairs: ProvidedFixture[] = [];
  let input: string | null = null;
  let output: string | null = null;
  let mode: "input" | "output" | null = null;
  const finish = () => {
    if (input !== null && output !== null && pairs.length < MAX_CASES) {
      const rawInput = input.trim();
      const rawOutput = output.trim();
      if (rawInput && rawOutput && rawInput.length <= MAX_SOURCE_CHARS && rawOutput.length <= MAX_SOURCE_CHARS) {
        const parsed = callableInputs(rawInput);
        let expected: unknown;
        let expectedValid = false;
        try { expected = literal(rawOutput); expectedValid = true; } catch { /* stdin text is still usable */ }
        pairs.push({
          id: "provided_" + (pairs.length + 1),
          input: rawInput,
          output: rawOutput,
          ...(parsed && expectedValid ? { args: parsed.args, kwargs: parsed.kwargs, expected } : {}),
        });
      }
    }
    input = null;
    output = null;
    mode = null;
  };
  for (const line of lines) {
    const label = LABEL.exec(line);
    if (label) {
      const isInput = /input/i.test(line.split(":")[0]);
      if (isInput) {
        finish();
        input = label[1];
        mode = "input";
      } else if (input !== null) {
        output = label[1];
        mode = "output";
      }
      continue;
    }
    if (/^\s*(?:example|test case|sample|explanation|constraints|note)\b/i.test(line)) {
      finish();
      continue;
    }
    if (mode === "input" && input !== null) input += "\n" + line;
    if (mode === "output" && output !== null) output += "\n" + line;
  }
  finish();
  // Repeated screenshots of the same example do not inflate evidence.
  const seen = new Set<string>();
  return pairs.filter(pair => {
    const key = JSON.stringify([pair.input, pair.output]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((pair, index) => ({ ...pair, id: "provided_" + (index + 1) }));
}

function callableName(code: string): string | null {
  if (/^\s*from\s+__future__\s+import\s+/m.test(code)) return null;
  const lines = code.split(/\r?\n/);
  const classIndex = lines.findIndex(line => /^\s*class\s+Solution\s*(?:\([^)]*\))?\s*:\s*(?:#.*)?$/.test(line));
  if (classIndex >= 0) {
    const classIndent = lines[classIndex].match(/^\s*/)?.[0].length ?? 0;
    for (const line of lines.slice(classIndex + 1)) {
      if (line.trim() && !/^\s*#/.test(line) && (line.match(/^\s*/)?.[0].length ?? 0) <= classIndent) break;
      const method = /^([ \t]+)def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      if (method && method[2] !== "__init__" && !method[2].startsWith("_")) return method[2];
    }
  }
  const standalone = /(?:^|\n)def\s+([a-zA-Z_]\w*)\s*\(/.exec(code);
  return standalone && !standalone[1].startsWith("_") ? standalone[1] : null;
}

function pythonDriver(fixtures: ProvidedFixture[], mode: "callable" | "stdin", language: string, method?: string): string {
  // The replacement is an escaped JSON string literal. Candidate text is not
  // interpolated into Python syntax and cannot break the driver string.
  const payload = JSON.stringify(fixtures.map(pair => mode === "callable"
    ? { id: pair.id, args: pair.args, kwargs: pair.kwargs, expected: pair.expected }
    : { id: pair.id, input: pair.input, expected: pair.output }));
  const methodLiteral = JSON.stringify(method || "");
  const driver = [
    "import copy, json, os, subprocess, sys, tempfile",
    "CA_SOURCE = <<<SOLUTION>>>",
    "CA_CASES = json.loads(" + JSON.stringify(payload) + ")",
    "CA_MODE = " + JSON.stringify(mode),
    "CA_LANGUAGE = " + JSON.stringify(language),
    "CA_METHOD = " + methodLiteral,
    "def ca_test(case, actual):",
    "    expected = case['expected']",
    "    ok = actual == expected",
    "    print(('PASS ' if ok else 'FAIL ') + case['id'])",
    "    print('CA_CASE ' + json.dumps({'id': case['id'], 'input': case.get('input', case.get('kwargs', case.get('args'))), 'expected': expected, 'actual': actual, 'status': 'passed' if ok else 'failed'}, default=str))",
    "    return ok",
    "def ca_execute():",
    "    if CA_MODE == 'callable':",
    "        scope = {'__name__': '__council_candidate__'}",
    "        from typing import List, Optional, Dict, Tuple, Set",
    "        scope.update({'List': List, 'Optional': Optional, 'Dict': Dict, 'Tuple': Tuple, 'Set': Set})",
    "        exec(compile(CA_SOURCE, '<candidate>', 'exec'), scope)",
    "        target = scope['Solution']() if 'Solution' in scope else scope",
    "        method = getattr(target, CA_METHOD) if not isinstance(target, dict) else target[CA_METHOD]",
    "        return all([ca_test(case, method(*copy.deepcopy(case['args']), **copy.deepcopy(case['kwargs']))) for case in CA_CASES])",
    "    with tempfile.TemporaryDirectory(prefix='council-fixtures-') as directory:",
    "        ext = {'python': '.py', 'cpp': '.cpp', 'rust': '.rs'}[CA_LANGUAGE]",
    "        src = os.path.join(directory, 'solution' + ext)",
    "        binary = os.path.join(directory, 'solution')",
    "        with open(src, 'w', encoding='utf-8') as file: file.write(CA_SOURCE)",
    "        command = {'python': [sys.executable, src], 'cpp': [binary], 'rust': [binary]}[CA_LANGUAGE]",
    "        if CA_LANGUAGE != 'python':",
    "            compiler = ['g++', '-std=c++23', '-O1', '-o', binary, src] if CA_LANGUAGE == 'cpp' else ['rustc', '--edition=2021', '-O', src, '-o', binary]",
    "            compilation = subprocess.run(compiler, text=True, capture_output=True, timeout=35, check=False)",
    "            if compilation.returncode:",
    "                print(compilation.stderr[:2000], file=sys.stderr)",
    "                raise RuntimeError('Candidate compilation failed')",
    "        passed = True",
    "        for case in CA_CASES:",
    "            result = subprocess.run(command, input=case['input'], text=True, capture_output=True, timeout=12, check=False)",
    "            if result.returncode:",
    "                print(result.stderr[:2000], file=sys.stderr)",
    "            passed = ca_test(case, result.stdout.rstrip('\\r\\n') if result.returncode == 0 else '<nonzero exit>') and passed",
    "        return passed",
    "if __name__ == '__main__':",
    "    try:",
    "        if not ca_execute(): sys.exit(1)",
    "    except Exception as error:",
    "        print('Harness V2 execution/adapter error: ' + str(error), file=sys.stderr)",
    "        sys.exit(2)",
  ];
  return driver.join("\n") + "\n";
}

export function buildProvidedHarness(question: string, language: string, candidateCode: string): ProvidedSuite | null {
  if (!["python", "cpp", "rust"].includes(language)) return null;
  // Multiple acceptable answers require a property comparator, not example equality.
  if (/\b(?:any order|any valid|multiple valid|in any order|any one|arbitrary order|order does not matter|modify in.place|in.place modification|do not return anything)\b/i.test(question)) return null;
  // Judge UI serializes trees/linked lists as arrays; a raw Python method
  // expects real nodes, not that displayed serialization.
  if (language === "python" && /\b(?:TreeNode|ListNode)\b/.test(candidateCode)) return null;
  const fixtures = extractProvidedFixtures(question);
  if (!fixtures.length) return null;
  const code = String(candidateCode || "");
  const name = language === "python" ? callableName(code) : null;
  const callable = Boolean(name && fixtures.every(f => f.args && f.kwargs && Object.hasOwn(f, "expected")));
  // Executable stdin contracts only: never pass function-call examples to a stdin runner.
  const stdinContract = /\b(?:standard input|stdin|input format|reads? from input|prints? to output)\b/i.test(question);
  const isStandalone = language === "python"
    ? /\b(?:input\s*\(|sys\.stdin|readline\s*\()/i.test(code)
    : language === "cpp" ? /\bint\s+main\s*\(/.test(code) : /\bfn\s+main\s*\(/.test(code);
  const stdin = !callable && stdinContract && isStandalone && fixtures.every(f => !/(?:^|,)\s*[A-Za-z_]\w*\s*=/.test(f.input));
  if (!callable && !stdin) return null;
  return {
    language, runnerLanguage: "python", source: "provided",
    providedCaseCount: fixtures.length,
    question,
    harness: pythonDriver(fixtures, callable ? "callable" : "stdin", language, name || undefined),
  };
}

/** Supplied examples require exact coverage; generated suites retain the broader gate. */
export function requiredHarnessCases(suite: { source?: string; providedCaseCount?: number }): number {
  return suite.source === "provided"
    ? Math.max(1, Number(suite.providedCaseCount) || 0)
    : MIN_GENERATED_HARNESS_CASES;
}

/** Only accepted fixture IDs count; extra PASS text is not verification. */
export function providedCaseEvidence(stdout: string, required: number): { passed: number; failed: number; complete: boolean } {
  const rows = new Map<string, string>();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.startsWith("CA_CASE ")) continue;
    try {
      const row = JSON.parse(line.slice(8));
      if (!/^provided_[1-9]\d*$/.test(row.id) || !["passed", "failed"].includes(row.status) || rows.has(row.id)) continue;
      rows.set(row.id, row.status);
    } catch { /* malformed trace is not evidence */ }
  }
  let passed = 0;
  let failed = 0;
  for (let n = 1; n <= required; n += 1) {
    if (rows.get("provided_" + n) === "passed") passed += 1;
    if (rows.get("provided_" + n) === "failed") failed += 1;
  }
  return { passed, failed, complete: passed + failed === required };
}
