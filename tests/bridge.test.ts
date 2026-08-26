import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The TypeScript-to-Rust boundary.
 *
 * `invoke("screenshot_add", { shot })` is a string and an untyped object on one
 * side and a typed function on the other, with nothing in between that either
 * compiler can see. Rename a Rust parameter and `npm run typecheck` stays green,
 * `cargo check` stays green, and the command fails at runtime with "invalid args
 * for command" the first time a real person presses the button.
 *
 * Tauri converts camelCase keys from JS to snake_case Rust parameters, and the
 * payload structs carry `#[serde(rename_all = "camelCase")]`, so the comparison
 * is done in camelCase on both sides.
 */

const RUST_DIR = "src-tauri/src";
const TS_FILES = ["src/lib/bridge.ts", "src/lib/sessions.ts"];

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Reads a balanced pair starting at `open`, respecting string literals. */
function balanced(src: string, open: number, o = "(", c = ")"): { body: string; end: number } {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"' || ch === "`") inStr = false;
      continue;
    }
    if (ch === '"' || ch === "`") inStr = true;
    else if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i };
    }
  }
  return { body: src.slice(open + 1), end: src.length };
}

const lineOf = (src: string, i: number) => src.slice(0, i).split("\n").length;

/**
 * Drops `//` comments.
 *
 * Rust allows a comment between two parameters, and `run_save` has three -- one
 * per new argument. Splitting a signature on commas without removing them first
 * silently loses the parameter that follows each comment, which is exactly the
 * kind of quiet miss this file exists to prevent.
 */
const stripComments = (s: string) => s.replace(/\/\/[^\n]*/g, "");

/**
 * The property names in an object literal or an inline type literal.
 *
 * `{ sessionId, mode }`, `{ sessionId: id }` and `{ sessionId: string; mode: string }`
 * all have to yield the same list, because the same check runs over call sites
 * and over the wrapper signatures behind them.
 */
function fieldNames(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
    .flatMap((l) => l.split(/[;,]/))
    .map((k) => k.trim())
    .map((k) => (k.includes(":") ? k.slice(0, k.indexOf(":")) : k).trim())
    .map((k) => k.replace(/\?$/, ""))
    .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
}

/** Splits on top-level commas: `Result<String, String>` is one item. */
function topLevelSplit(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "<" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === ">" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// --------------------------------------------------------- rust commands

const rust = readdirSync(RUST_DIR)
  .filter((f) => f.endsWith(".rs"))
  .map((f) => ({ file: f, src: readFileSync(join(RUST_DIR, f), "utf8") }));

/** Injected by Tauri rather than sent from JS, so JS must not send them. */
const INJECTED = /^(tauri::)?(State|AppHandle|Window|WebviewWindow|Runtime)\b|^tauri::State|^AppHandle|^Window|^WebviewWindow/;

const commands = new Map<string, { args: string[]; file: string; line: number }>();

for (const { file, src } of rust) {
  for (const m of src.matchAll(/#\[tauri::command\][\s\S]{0,120}?fn\s+(\w+)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const { body } = balanced(src, open);
    const args: string[] = [];
    for (const part of topLevelSplit(stripComments(body))) {
      const p = part.trim();
      if (!p) continue;
      const nm = /^([a-z_][a-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(p);
      if (!nm) continue;
      if (INJECTED.test(nm[2].trim())) continue;
      args.push(camel(nm[1]));
    }
    commands.set(m[1], { args, file, line: lineOf(src, m.index!) });
  }
}

console.log("\n1. the Rust commands parse");
check("commands found", commands.size >= 20, String(commands.size));
check(
  "run_save takes the vision-pass fields",
  ["contextMode", "extractedContext", "extractionAgreed"].every((a) =>
    commands.get("run_save")?.args.includes(a)
  ),
  (commands.get("run_save")?.args ?? []).join(",")
);

// ----------------------------------------------------- registered handlers

const libRs = rust.find((r) => r.file === "lib.rs")!.src;
const handlerBlock = /generate_handler!\s*\[([\s\S]*?)\]/.exec(libRs);
const registered = new Set(
  (handlerBlock?.[1] ?? "")
    .split(",")
    .map((x) => x.trim().split("::").pop() ?? "")
    .filter(Boolean)
);

console.log("\n2. every command is registered with the app");
for (const [name, meta] of commands) {
  check(`${name} (${meta.file}:${meta.line})`, registered.has(name));
}

// -------------------------------------------------------- the TS call sites

console.log("\n3. every invoke matches its command's signature");
let checked = 0;
let opaque = 0;

for (const file of TS_FILES) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/invoke(?:<[^>]*>)?\s*\(\s*"([a-z_]+)"\s*(,?)/g)) {
    const name = m[1];
    const line = lineOf(src, m.index!);
    const cmd = commands.get(name);

    check(`${file}:${line} "${name}" exists in Rust`, !!cmd);
    if (!cmd) continue;

    if (!m[2]) {
      // No second argument at all: the command must take none.
      checked++;
      check(`${file}:${line} "${name}" sends nothing, takes nothing`, cmd.args.length === 0, cmd.args.join(","));
      continue;
    }

    const after = src.slice(m.index! + m[0].length);
    const brace = after.indexOf("{");
    const paren = after.indexOf(")");
    let keys: string[];

    if (brace === -1 || (paren !== -1 && paren < brace)) {
      // `invoke("run_save", args)` -- a variable rather than a literal. The
      // wrapper declares its own parameter type inline, so the shape is still
      // here to read; falling back to "unchecked" would have left the one
      // command with the most arguments as the one nothing verified.
      const ident = after.slice(0, paren === -1 ? 40 : paren).trim().replace(/,$/, "").trim();
      const decl = new RegExp(
        `(?:function\\s+\\w+|const\\s+\\w+\\s*=)[^(]*\\(\\s*${ident}\\s*:\\s*\\{`
      ).exec(src);
      if (!/^[A-Za-z_$][\w$]*$/.test(ident) || !decl) {
        opaque++;
        continue;
      }
      const { body } = balanced(src, src.indexOf("{", decl.index), "{", "}");
      keys = fieldNames(body);
    } else {
      const { body } = balanced(after, brace, "{", "}");
      keys = fieldNames(body);
    }

    checked++;
    const missing = cmd.args.filter((a) => !keys.includes(a));
    const extra = keys.filter((k) => !cmd.args.includes(k));
    check(`${file}:${line} "${name}" sends every argument`, missing.length === 0, `missing ${missing.join(",")}`);
    check(`${file}:${line} "${name}" sends nothing extra`, extra.length === 0, `unexpected ${extra.join(",")}`);
  }
}

console.log(`  (${checked} call sites checked, ${opaque} passing an object variable)`);

// ------------------------------------------- 4: the one payload struct

console.log("\n4. the screenshot payload struct matches its TypeScript");
const sessionsRs = rust.find((r) => r.file === "sessions.rs")!.src;

// Read the type off the command rather than hard-coding a name, so renaming the
// struct cannot quietly turn this section into a no-op.
const addSig = /#\[tauri::command\][\s\S]{0,120}?fn\s+screenshot_add\s*\(/.exec(sessionsRs);
check("screenshot_add found", !!addSig);
const shotType = addSig
  ? /\bshot\s*:\s*(\w+)/.exec(balanced(sessionsRs, addSig.index! + addSig[0].length - 1).body)?.[1]
  : undefined;
check("its payload type is named in the signature", !!shotType, String(shotType));

const structM = shotType
  ? new RegExp(`struct\\s+${shotType}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(sessionsRs)
  : null;
check(`${shotType ?? "payload"} struct found in Rust`, !!structM);

if (structM) {
  const rustFields = stripComments(structM[1])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("#["))
    .map((l) => /^(?:pub\s+)?([a-z_][a-z0-9_]*)\s*:\s*([\s\S]+?),?$/.exec(l))
    .filter((x): x is RegExpExecArray => !!x)
    .map((x) => ({ name: camel(x[1]), optional: /^Option</.test(x[2].trim()) }));

  const ts = readFileSync("src/lib/sessions.ts", "utf8");
  const ifaceM = /interface\s+NewScreenshot\s*\{([\s\S]*?)\n\}/.exec(ts);
  check("NewScreenshot found in TypeScript", !!ifaceM);

  if (ifaceM) {
    const tsFields = ifaceM[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
      .map((l) => /^([A-Za-z_$][\w$]*)(\??)\s*:/.exec(l))
      .filter((x): x is RegExpExecArray => !!x)
      .map((x) => ({ name: x[1], optional: x[2] === "?" }));

    for (const rf of rustFields) {
      const tf = tsFields.find((t) => t.name === rf.name);
      check(`Rust field ${rf.name} exists in TypeScript`, !!tf);
      if (tf && !rf.optional) {
        // An optional TS field feeding a required Rust field is the bug that
        // only appears when someone happens not to set it.
        check(`${rf.name} is required on both sides`, !tf.optional);
      }
    }
    for (const tf of tsFields) {
      check(`TypeScript field ${tf.name} exists in Rust`, rustFields.some((r) => r.name === tf.name));
    }
  }
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall bridge checks passed\n");
process.exit(fail ? 1 : 0);
