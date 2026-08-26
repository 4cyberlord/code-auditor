import { highlight, grammarFor, type TokenKind } from "../src/lib/highlight.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

/** Every highlighter's first duty: never change the text it was given. */
const roundTrips = (code: string, lang: string) =>
  highlight(code, lang).map((t) => t.text).join("") === code;

const kindOf = (code: string, lang: string, needle: string): TokenKind | undefined =>
  highlight(code, lang).find((t) => t.text === needle)?.kind;

console.log("\n1. the code always survives intact");
{
  const samples: [string, string][] = [
    ["def f(x):\n    return x + 1  # add\n", "python"],
    ["const a = `t${1}`; // note\n/* block */\n", "javascript"],
    ["#include <stdio.h>\nint main(){ printf(\"hi\\n\"); }", "c"],
    ["fn main() { println!(\"{}\", 1.5e3); }", "rust"],
    ["", "python"],
    ["   \n\n  ", "python"],
    ["не ascii — em dash ✓", "python"],
    ["def broken(:\n  '''unterminated", "python"],
  ];
  for (const [code, lang] of samples) {
    check(`${lang}: ${JSON.stringify(code.slice(0, 24))}`, roundTrips(code, lang));
  }
  check("an unknown language passes straight through", roundTrips("§ weird ¬", "brainfuck"));
}

console.log("\n2. python, as it actually arrives from a model");
{
  const code = [
    "from typing import List",
    "class Solution:",
    "    def twoSum(self, nums: List[int], target: int) -> List[int]:",
    "        # Map from number to its index",
    "        seen = {}",
    '        raise ValueError("No two sum solution")',
  ].join("\n");

  check("keyword", kindOf(code, "python", "class") === "keyword");
  check("definition name", kindOf(code, "python", "twoSum") === "func");
  check("builtin type", kindOf(code, "python", "List") === "type");
  check("self", kindOf(code, "python", "self") === "type");
  const cm = highlight(code, "python").find((t) => t.kind === "comment");
  check("comment runs to end of line", cm?.text === "# Map from number to its index", cm?.text);
  const st = highlight(code, "python").find((t) => t.kind === "string");
  check("string keeps its quotes", st?.text === '"No two sum solution"', st?.text);
}

console.log("\n3. the things that trip naive highlighters");
{
  // A keyword inside a string is not a keyword.
  const s = highlight('x = "class def return"', "python");
  check("keywords inside a string stay string", !s.some((t) => t.kind === "keyword"), JSON.stringify(s));

  // A quote inside a comment must not open a string.
  const c = highlight("# it's fine\nx = 1", "python");
  check("apostrophe in a comment does not open a string", c.every((t) => t.kind !== "string"));

  // An escaped quote does not close the string.
  const e = highlight('a = "he said \\"hi\\" ok"; b = 2', "javascript");
  const str = e.find((t) => t.kind === "string");
  check("escaped quotes stay inside", str?.text === '"he said \\"hi\\" ok"', str?.text);

  // A half-written line, which is what streaming looks like.
  const half = highlight('const s = "unterminated\nconst n = 5', "javascript");
  check("an unterminated string stops at the newline", half.some((t) => t.kind === "keyword" && t.text === "const"), JSON.stringify(half));

  // Python triple quotes span lines and swallow everything.
  const tri = highlight('"""\nclass not_a_keyword\n"""\nx = 1', "python");
  check("triple-quoted blocks are one string", tri[0].kind === "string" && tri[0].text.includes("class"));

  // A block comment that never closes.
  check("unclosed block comment does not lose the tail", roundTrips("/* forever", "javascript"));
}

console.log("\n4. numbers");
{
  check("float", kindOf("x = 3.14", "python", "3.14") === "number");
  check("hex", kindOf("x = 0xFF", "c", "0xFF") === "number");
  check("leading dot", kindOf("x = .5", "javascript", ".5") === "number");
  // `kindOf` cannot be used here: adjacent plain runs are merged by design, so
  // "x2" never appears as a token of its own. The property that matters is that
  // it was not swallowed into a number.
  const withDigits = highlight("var x2 = 1", "javascript");
  check(
    "a name with digits is not a number",
    withDigits.filter((t) => t.kind === "number").every((t) => !t.text.includes("x")),
    JSON.stringify(withDigits)
  );
  check("and the digit is still found on its own", withDigits.some((t) => t.kind === "number" && t.text === "1"));
}

console.log("\n5. every language we can run is highlighted");
{
  for (const lang of [
    "python", "javascript", "typescript", "bash", "ruby", "php",
    "c", "cpp", "java", "go", "rust",
  ]) {
    check(lang, grammarFor(lang) !== null);
  }
  for (const alias of ["py", "js", "ts", "c++", "golang", "rs", "rb", "sh", ".py", "Python"]) {
    check(`alias ${alias}`, grammarFor(alias) !== null);
  }
  check("something we do not know returns null", grammarFor("cobol") === null);
}

console.log("\n6. runs are merged, not one span per character");
{
  const tokens = highlight("        return x + 1", "python");
  check("no single-character plain runs left over", tokens.filter((t) => t.kind === "plain" && t.text.length === 1).length === 0, JSON.stringify(tokens));
  check("kept short", tokens.length < 8, String(tokens.length));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall highlight checks passed\n");
process.exit(fail ? 1 : 0);
