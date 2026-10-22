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
  runnerLanguage: "python" | "cpp" | "rust";
  source: "provided" | "generated";
  providedCaseCount: number;
  /** Retained so each candidate can get an adapter for its own callable API. */
  question: string;
  harness: string;
  harnessVersion?: string;
  contractHash?: string;
  referenceCode?: string;
  candidateAsString?: boolean;
  templateId?: string;
  unordered?: boolean;
};


// ------------------------------------------------- native function adapters
//
// Judge-style APIs (a Solution class or a free function) need a typed call, not
// stdin. These adapters cover the types below; anything else returns null so the
// existing reference-harness path takes over.

type NativeType =
  | { kind: "int" | "float" | "bool" | "string" }
  | { kind: "list"; item: NativeType };

interface NativeArgument {
  name: string;
  type: NativeType;
  decl: string;
}

interface NativeSignature {
  name: string;
  args: NativeArgument[];
  ret: NativeType;
  retDecl: string;
  owner: "class" | "free";
  receiver: boolean;
}

function cppTypeName(type: NativeType): string {
  if (type.kind === "list") return `std::vector<${cppTypeName(type.item)}>`;
  if (type.kind === "float") return "double";
  if (type.kind === "bool") return "bool";
  if (type.kind === "string") return "std::string";
  return "long long";
}

function cppType(raw: string): NativeType | null {
  const text = raw.replace(/\bconst\b/g, "").replace(/[&\s]+$/g, "").trim();
  if (text === "bool") return { kind: "bool" };
  if (text === "double" || text === "float") return { kind: "float" };
  if (text === "string" || text === "std::string") return { kind: "string" };
  const list = /^(?:std::)?vector<(.+)>$/.exec(text);
  if (list) {
    const item = cppType(list[1]);
    return item ? { kind: "list", item } : null;
  }
  return /^(?:unsigned\s+)?(?:int|long|short|size_t|long long)$/.test(text) ? { kind: "int" } : null;
}

function rustType(raw: string): NativeType | null {
  const text = raw.trim().replace(/^&(?!(?:str|\[))/, "").trim();
  if (text === "bool") return { kind: "bool" };
  if (text === "f32" || text === "f64") return { kind: "float" };
  if (text === "String" || text === "&str" || text === "str") return { kind: "string" };
  const list = /^Vec<(.+)>$/.exec(text);
  if (list) {
    const item = rustType(list[1]);
    return item ? { kind: "list", item } : null;
  }
  if (/^(?:i|u)(?:8|16|32|64|size)$/.test(text)) return { kind: "int" };
  return null;
}

function nativeLiteral(type: NativeType, value: unknown, language: "cpp" | "rust"): string | null {
  if (type.kind === "list") {
    if (!Array.isArray(value)) return null;
    const items = value.map((item) => nativeLiteral(type.item, item, language));
    if (items.some((item) => item === null)) return null;
    return language === "cpp"
      ? `std::vector<${cppTypeName(type.item)}>{${items.join(", ")}}`
      : `vec![${items.join(", ")}]`;
  }
  if (type.kind === "bool") return typeof value === "boolean" ? String(value) : null;
  if (type.kind === "float") return typeof value === "number" ? `${value}` : null;
  if (type.kind === "int") return Number.isInteger(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  return language === "cpp" ? JSON.stringify(value) : `String::from(${JSON.stringify(value)})`;
}

function cppDeclLiteral(decl: string, value: unknown): string | null {
  const list = /^(?:std::)?vector<(.+)>$/.exec(decl.trim());
  if (list) {
    if (!Array.isArray(value)) return null;
    const inner = list[1].trim();
    const items = value.map((item) => cppDeclLiteral(inner, item));
    if (items.some((item) => item === null)) return null;
    return `${decl.trim()}{${items.join(", ")}}`;
  }
  return nativeLiteral(cppType(decl) || { kind: "int" }, value, "cpp");
}

function splitParams(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "<" || character === "(") depth += 1;
    if (character === ">" || character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(raw.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function cppArguments(raw: string): NativeArgument[] | null {
  const args: NativeArgument[] = [];
  for (const param of splitParams(raw)) {
    const match = /^(.*?)[\s*&]+([A-Za-z_]\w*)\s*$/.exec(param.trim());
    if (!match) return null;
    const type = cppType(match[1]);
    if (!type) return null;
    args.push({ name: match[2], type, decl: match[1].replace(/\bconst\b/g, "").replace(/[&\s]+/g, " ").trim() });
  }
  return args;
}

function nativeValue(fixture: ProvidedFixture, argument: NativeArgument, position: number): unknown {
  if (Array.isArray(fixture.args) && position < fixture.args.length) return fixture.args[position];
  return fixture.kwargs?.[argument.name];
}

function cppSignature(code: string): NativeSignature | null {
  const classAt = code.search(/\bclass\s+Solution\b/);
  if (classAt >= 0) {
    const body = code.slice(classAt).replace(/^\s*(?:public|private|protected)\s*:/gm, "");
    const method = /([A-Za-z_][\w:<>,\s]*?(?:<[^>]*>)?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:const\s*)?\{/.exec(body);
    if (!method || method[2] === "Solution") return null;
    const args = cppArguments(method[3]);
    const ret = cppType(method[1]);
    if (!ret || !args) return null;
    return { name: method[2], args, ret, retDecl: method[1].trim(), owner: "class", receiver: true };
  }
  const free = /^\s*(?:static\s+)?([A-Za-z_][\w:<>,\s]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/m.exec(code);
  if (!free || free[2] === "main") return null;
  const args = cppArguments(free[3]);
  const ret = cppType(free[1]);
  if (!ret || !args) return null;
  return { name: free[2], args, ret, retDecl: free[1].trim(), owner: "free", receiver: false };
}

export function rustSignature(code: string): NativeSignature | null {
  const implAt = code.search(/\bimpl\s+Solution\s*\{/);
  const source = implAt >= 0 ? code.slice(implAt) : code;
  const method = /\bpub\s+fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*->\s*([^{]+)\{/.exec(source);
  if (!method || method[1] === "main") return null;
  const params = splitParams(method[2]);
  const receiver = params.some((part) => /^&?\s*(?:mut\s+)?self\b/.test(part));
  const valueParams = params.filter((part) => !/^&?\s*(?:mut\s+)?self\b/.test(part));
  const args: NativeArgument[] = [];
  for (const param of valueParams) {
    const [rawName, ...rest] = param.split(":");
    const type = rustType(rest.join(":"));
    if (!type || !rawName.trim()) return null;
    args.push({ name: rawName.trim().replace(/^mut\s+/, ""), type, decl: rest.join(":").trim() });
  }
  const ret = rustType(method[3]);
  if (!ret) return null;
  return { name: method[1], args, ret, retDecl: method[3].trim(), owner: implAt >= 0 ? "class" : "free", receiver };
}

function cppDriver(signature: NativeSignature, fixtures: ProvidedFixture[], unordered: boolean): string | null {
  const blocks: string[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const declarations: string[] = [];
    for (const [position, argument] of signature.args.entries()) {
      const literal = cppDeclLiteral(argument.decl, nativeValue(fixture, argument, position));
      if (literal === null) return null;
      declarations.push(`    ${argument.decl} a${position} = ${literal};`);
    }
    const expected = cppDeclLiteral(signature.retDecl, fixture.expected);
    if (expected === null) return null;
    const args = signature.args.map((_, position) => `a${position}`).join(", ");
    const call = signature.owner === "class" ? `solution.${signature.name}(${args})` : `${signature.name}(${args})`;
    const sort = unordered && signature.ret.kind === "list" ? "    std::sort(actual.begin(), actual.end());\n" : "";
    blocks.push([
      "  {",
      ...declarations,
      `    ${signature.retDecl} expected = ${expected};`,
      `    auto actual = ${call};`,
      sort.replace(/\n$/, ""),
      `    bool ok = actual == expected;`,
      `    std::ostringstream a, e; ca_put(a, actual); ca_put(e, expected);`,
      `    std::cout << "CA_CASE {\\"id\\":\\"${fixture.id}\\",\\"status\\":\\"" << (ok ? "passed" : "failed") << "\\",\\"expected\\":" << e.str() << ",\\"actual\\":" << a.str() << "}" << std::endl;`,
      "  }",
    ].filter(Boolean).join("\n"));
  }
  const instance = signature.owner === "class"
    ? `  std::vector<long long> unused;\n  (void)unused;`
    : "";
  return [
    "#include <algorithm>",
    "#include <iostream>",
    "#include <sstream>",
    "#include <string>",
    "#include <vector>",
    "using namespace std;",
    "static void ca_put(ostringstream& o, bool v) { o << (v ? \"true\" : \"false\"); }",
    "static void ca_put(ostringstream& o, const string& v) { o << '\"'; for (char c : v) { if (c == '\"' || c == '\\\\') o << '\\\\'; o << c; } o << '\"'; }",
    "template <class T> static void ca_put(ostringstream& o, const T& v) { o << v; }",
    "template <class T> static void ca_put(ostringstream& o, const vector<T>& v) { o << '['; for (size_t i = 0; i < v.size(); ++i) { if (i) o << ','; ca_put(o, v[i]); } o << ']'; }",
    "",
    "<<<SOLUTION>>>",
    "",
    "int main() {",
    instance,
    "  Solution solution;".replace("Solution solution;", signature.owner === "class" ? "  Solution solution;" : ""),
    ...blocks,
    "  return 0;",
    "}",
  ].filter((line) => line !== "").join("\n");
}

function rustDriver(signature: NativeSignature, fixtures: ProvidedFixture[], unordered: boolean, declareSolution: boolean): string | null {
  const blocks: string[] = [];
  for (const fixture of fixtures) {
    const declarations: string[] = [];
    for (const [position, argument] of signature.args.entries()) {
      const literal = nativeLiteral(argument.type, nativeValue(fixture, argument, position), "rust");
      if (literal === null) return null;
      declarations.push(`    let a${position} = ${literal};`);
    }
    const expected = nativeLiteral(signature.ret, fixture.expected, "rust");
    if (expected === null) return null;
    const args = signature.args.map((argument, position) => argument.decl.startsWith("&") ? `&a${position}` : `a${position}`).join(", ");
    const call = signature.owner === "class"
      ? (signature.receiver ? `solution.${signature.name}(${args})` : `Solution::${signature.name}(${args})`)
      : `${signature.name}(${args})`;
    const sort = unordered && signature.ret.kind === "list" ? "    actual.sort();\n" : "";
    blocks.push([
      "  {",
      ...declarations,
      `    let expected = ${expected};`,
      `    let actual = ${call};`,
      sort.replace(/\n$/, ""),
      "    let ok = actual == expected;",
      `    println!("CA_CASE {{\\"id\\":\\"${fixture.id}\\",\\"status\\":\\"{}\\",\\"expected\\":{:?},\\"actual\\":{:?}}}", if ok { "passed" } else { "failed" }, expected, actual);`,
      "  }",
    ].filter(Boolean).join("\n"));
  }
  return [
    signature.owner === "class" && declareSolution ? "struct Solution;" : "",
    "<<<SOLUTION>>>",
    "",
    "fn main() {",
    signature.owner === "class" && signature.receiver ? "  let solution = Solution;" : "",
    ...blocks,
    "}",
  ].filter((line) => line !== "").join("\n");
}

/** Bump whenever a template or comparison rule changes. */
import { bestTemplate } from "./harnessRegistry.ts";

export const HARNESS_ENGINE_VERSION = "v2.1";

/** Stable identity for the contract a harness was built for. */
export function contractHash(question: string, fixtures: ProvidedFixture[]): string {
  // Browser-safe and stable: two FNV-1a lanes, not a cryptographic digest.
  const material = [HARNESS_ENGINE_VERSION, String(question || ""),
    ...fixtures.flatMap((fixture) => [String(fixture.input), String(fixture.output)])].join("\u0000");
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const character of material) {
    const code = character.codePointAt(0) ?? 0;
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b ^ code, 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const MAX_CASES = 16;
const MAX_SOURCE_CHARS = 6000;
const LABEL = /^\s*(?:sample\s+)?(?:(?:arg(?:ument)?s?)|(?:input)|(?:returns?|output|result|expected(?:\s+(?:output|result))?))\s*:\s*(.*)$/i;
const INLINE_LABEL = /\b(?:sample\s+)?(?:(?:arg(?:ument)?s?)|input|output|returns?|result|expected(?:\s+(?:output|result))?)\s*:/gi;
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
  // Vision readers often flatten a screenshot's layout into one line, e.g.
  // "Example 1: Input: ... Output: ...". Split only at explicit field labels
  // before parsing; values themselves are kept verbatim and never evaluated.
  const lines = String(question || "").slice(0, 40_000).split(/\r?\n/).flatMap((line) => {
    const labels = [...line.matchAll(INLINE_LABEL)];
    if (labels.length < 2) return [line];
    const result: string[] = [];
    let start = 0;
    for (const label of labels) {
      const index = label.index ?? 0;
      if (index > start) result.push(line.slice(start, index).trimEnd());
      start = index;
    }
    result.push(line.slice(start));
    return result.filter(part => part.trim());
  });
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
  const ARROW = /^\s*(.+?)\s*(?:=>|->)\s*(.+?)\s*$/;
  for (const line of lines) {
    // "nums = [2,7], target = 9 => [0,1]" is a complete case on one line. The
    // signature also uses "->", so skip lines that define one.
    const arrow = !/^\s*(?:def|class|function|fn|public|private|static)\b/.test(line) && ARROW.exec(line);
    if (arrow && !/^\s*(?:example|input|output|sample|note)\b/i.test(line) && pairs.length < MAX_CASES) {
      const rawInput = arrow[1].trim();
      const rawOutput = arrow[2].replace(/^["'`]|["'`]$/g, "").trim();
      try {
        const expected = literal(rawOutput);
        const parsed = callableInputs(rawInput);
        pairs.push({
          id: "provided_" + (pairs.length + 1), input: rawInput, output: rawOutput,
          ...(parsed ? { args: parsed.args, kwargs: parsed.kwargs, expected } : {}),
        });
        continue;
      } catch { /* fall through to the label parser */ }
    }
    const label = LABEL.exec(line);
    if (label) {
      const isInput = /arg|input/i.test(line.split(":")[0]);
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

const ANY_ORDER = /\b(?:any order|in any order|arbitrary order|order does not matter|any one)\b/i;
const HARD_TO_COMPARE = /\b(?:any valid|multiple valid|modify in.place|in.place modification|do not return anything)\b/i;

/** Equality-based cases cannot validate a contract that permits several
 * correct representations. Ordering-only contracts are still comparable once
 * both sides are normalized. */
export function harnessOrderMode(question: string): { unordered: boolean; comparable: boolean } {
  const text = String(question || "");
  return { unordered: ANY_ORDER.test(text), comparable: !HARD_TO_COMPARE.test(text) };
}

function pythonDriver(fixtures: ProvidedFixture[], mode: "callable" | "stdin", language: string, method?: string, unordered = false): string {
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
    "CA_UNORDERED = " + (unordered ? "True" : "False"),
    "def ca_norm(value):",
    "    if isinstance(value, list):",
    "        return sorted((ca_norm(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True, default=str))",
    "    if isinstance(value, dict):",
    "        return {key: ca_norm(item) for key, item in value.items()}",
    "    return value",
    "def ca_test(case, actual):",
    "    expected = case['expected']",
    "    ok = (ca_norm(actual) == ca_norm(expected)) if CA_UNORDERED else (actual == expected)",
    "    print(('PASS ' if ok else 'FAIL ') + case['id'])",
    "    trace_input = case['input'] if 'input' in case else {'args': case.get('args'), 'kwargs': case.get('kwargs')} ",
    "    print('CA_CASE ' + json.dumps({'id': case['id'], 'input': trace_input, 'expected': expected, 'actual': actual, 'status': 'passed' if ok else 'failed'}, default=str))",
    "    return ok",
    "def ca_execute():",
    "    if CA_MODE == 'callable':",
    "        scope = {'__name__': '__council_candidate__'}",
    "        from typing import List, Optional, Dict, Tuple, Set",
    "        scope.update({'List': List, 'Optional': Optional, 'Dict': Dict, 'Tuple': Tuple, 'Set': Set})",
    "        exec(compile(CA_SOURCE, '<candidate>', 'exec'), scope)",
    "        target = scope['Solution']() if 'Solution' in scope else scope",
    "        if CA_METHOD:",
    "            method = getattr(target, CA_METHOD) if not isinstance(target, dict) else target[CA_METHOD]",
    "        elif not isinstance(target, dict):",
    "            names = [name for name in dir(target) if not name.startswith('_') and callable(getattr(target, name, None))]",
    "            method = getattr(target, names[0]) if names else None",
    "        else:",
    "            names = [name for name, value in target.items() if not name.startswith('_') and callable(value)]",
    "            method = target[names[0]] if names else None",
    "        if method is None: raise RuntimeError('No public callable found in candidate')",
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

/**
 * Compile a small model-authored JSON test specification into our fixed Python
 * runner. The model supplies data and an independent reference, never runner
 * code, so quoting/indentation/syntax failures cannot strand the Council.
 */
export function buildGeneratedPythonHarness(
  question: string,
  rawSpec: string,
  candidateCode = "",
): ProvidedSuite | null {
  const order = harnessOrderMode(question);
  if (!order.comparable) return null;
  let spec: Record<string, unknown>;
  try {
    const text = String(rawSpec || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    spec = JSON.parse(text.slice(first, last + 1));
  } catch { return null; }

  const referenceCode = [spec.reference_code, spec.referenceCode, spec.reference, spec.solution, spec.code]
    .find((value): value is string => typeof value === "string" && !!value.trim())?.trim() || "";
  if (!referenceCode || referenceCode.length > 24_000) return null;
  const rawCases = [spec.cases, spec.tests, spec.test_cases, spec.testCases]
    .find((value): value is unknown[] => Array.isArray(value)) || [];
  if (rawCases.length < MIN_GENERATED_HARNESS_CASES || rawCases.length > MAX_CASES) return null;
  const mode = spec.mode === "stdin" ? "stdin" : spec.mode === "callable" ? "callable" : null;
  if (!mode) return null;

  const supplied = extractProvidedFixtures(question);
  const cases: ProvidedFixture[] = [];
  const seen = new Set<string>();
  for (const [index, value] of rawCases.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    let fixture: ProvidedFixture;
    if (mode === "callable") {
      const args = Array.isArray(row.args) ? row.args : Array.isArray(row.input) ? row.input : [];
      const kwargs = row.kwargs && typeof row.kwargs === "object" && !Array.isArray(row.kwargs)
        ? row.kwargs as Record<string, unknown> : {};
      const hasExpected = Object.hasOwn(row, "expected") || Object.hasOwn(row, "output") || Object.hasOwn(row, "want");
      if (!hasExpected) return null;
      const expected = Object.hasOwn(row, "expected") ? row.expected : Object.hasOwn(row, "output") ? row.output : row.want;
      fixture = { id: `generated_${index + 1}`, input: JSON.stringify([args, kwargs]), output: JSON.stringify(expected), args, kwargs, expected };
    } else {
      const expectedOutput = typeof row.expected === "string" ? row.expected : typeof row.output === "string" ? row.output : null;
      if (typeof row.input !== "string" || expectedOutput === null) return null;
      fixture = { id: `generated_${index + 1}`, input: row.input, output: expectedOutput };
    }
    const key = JSON.stringify(mode === "callable" ? [fixture.args, fixture.kwargs] : fixture.input);
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push(fixture);
  }
  if (cases.length < MIN_GENERATED_HARNESS_CASES) return null;

  // If we could safely parse statement examples, require every one to appear
  // with its exact input and expected value. This prevents a JSON-mode answer
  // from silently dropping or rewriting the examples it was asked to preserve.
  if (supplied.length) {
    const retained = supplied.every(example => cases.some(test => mode === "callable"
      ? JSON.stringify([test.args, test.kwargs, test.expected]) === JSON.stringify([
          example.args?.length ? example.args : Object.values(example.kwargs || {}), {}, example.expected,
        ])
      : test.input === example.input && test.output === example.output));
    if (!retained) return null;
  }
  return {
    language: "python", runnerLanguage: "python", source: "generated",
    providedCaseCount: cases.length, question, candidateAsString: true,
    harness: pythonDriver(cases, mode, "python", callableName(candidateCode) || (typeof spec.method === "string" ? spec.method : undefined), order.unordered),
    unordered: order.unordered,
    harnessVersion: HARNESS_ENGINE_VERSION,
    contractHash: contractHash(question, cases),
    referenceCode,
  };
}

export function pythonHarnessJsonSystemPrompt(): string {
  return [
    "You design test DATA and an independent Python reference implementation for one coding problem.",
    "Do not write a test harness, assertions, runner, Markdown, or prose. Return one JSON object only.",
    'Schema: {"mode":"callable|stdin","method":"optional public method name","cases":[...],"reference_code":"complete independent Python implementation"}.',
    "For callable mode each case is {id,args:[JSON values],kwargs:{JSON values},expected:JSON value}.",
    "For stdin mode each case is {id,input:string,expected:string}; preserve exact statement examples.",
    `Return at least ${MIN_GENERATED_HARNESS_CASES} distinct cases and no more than ${MAX_CASES}; include all supplied examples exactly and add only contract-justified cases.`,
    "The reference_code must implement the exact problem interface, independently of the candidate solutions. Never invent a signature or expected result. If the contract cannot support a reliable oracle, return {\"error\":\"insufficient contract\"}.",
  ].join(" ");
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
  const signature = language === "cpp" ? cppSignature(code) : language === "rust" ? rustSignature(code) : null;
  const callableFixtures = signature && fixtures.every((fixture) =>
    Object.hasOwn(fixture, "expected") &&
    signature.args.every((argument, position) => nativeValue(fixture, argument, position) !== undefined))
    ? fixtures : null;
  if (signature && callableFixtures) {
    const driver = language === "cpp"
      ? cppDriver(signature, callableFixtures, harnessOrderMode(question).unordered)
      : rustDriver(signature, callableFixtures, harnessOrderMode(question).unordered, !/\bstruct\s+Solution\b/.test(code));
    if (driver) return {
      language, runnerLanguage: language as "cpp" | "rust", source: "provided",
      providedCaseCount: callableFixtures.length,
      question, harness: driver, candidateAsString: false,
      unordered: harnessOrderMode(question).unordered,
      harnessVersion: HARNESS_ENGINE_VERSION,
      contractHash: contractHash(question, callableFixtures),
      templateId: bestTemplate(language, "callable-vector")?.id,
    };
  }
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
    harness: pythonDriver(fixtures, callable ? "callable" : "stdin", language, name || undefined, harnessOrderMode(question).unordered),
    unordered: harnessOrderMode(question).unordered,
    harnessVersion: HARNESS_ENGINE_VERSION,
    contractHash: contractHash(question, fixtures),
    templateId: bestTemplate(language, callable ? "callable-vector" : "stdin")?.id,
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
