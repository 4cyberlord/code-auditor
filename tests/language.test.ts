import assert from "node:assert/strict";
import { normalizeCodeLanguage, candidateLanguage } from "../src/lib/council.ts";

// The bug this file exists for: a model that labels its fence with the standard
// it wrote against, not the bare language. Every one of these came back
// "Unsupported benchmark language" and the candidate was dropped unrun.
for (const tag of ["c++17", "c++20", "c++23", "C++17", "cpp17", "cpp20", "cxx2x", "c++", "cpp", "cc", "cxx", "C++ 17"]) {
  assert.equal(normalizeCodeLanguage(tag), "cpp", `${tag} should be cpp`);
}

for (const tag of ["c", "c99", "c11", "c17", "c23", "C11"]) {
  assert.equal(normalizeCodeLanguage(tag), "c", `${tag} should be c`);
}

for (const tag of ["python", "python3", "py", "py3", "Python3.11", "python3.12"]) {
  assert.equal(normalizeCodeLanguage(tag), "python", `${tag} should be python`);
}

for (const tag of ["javascript", "js", "node", "nodejs", "node20", "mjs", "cjs", "es2022"]) {
  assert.equal(normalizeCodeLanguage(tag), "javascript", `${tag} should be javascript`);
}

assert.equal(normalizeCodeLanguage("ts"), "typescript");
assert.equal(normalizeCodeLanguage("rs"), "rust");
assert.equal(normalizeCodeLanguage("golang"), "go");
assert.equal(normalizeCodeLanguage("rb"), "ruby");
assert.equal(normalizeCodeLanguage("zsh"), "bash");
assert.equal(normalizeCodeLanguage(".py"), "python");

// Unknown languages pass through rather than being silently swallowed, so a
// genuinely unsupported language still reports its own name in the error.
assert.equal(normalizeCodeLanguage("haskell"), "haskell");
assert.equal(normalizeCodeLanguage(""), "");
assert.equal(normalizeCodeLanguage("   "), "");

// A candidate reaches the runtime table through this, so it must agree.
assert.equal(candidateLanguage({ kind: "code", language: "c++17", code: "x" } as never), "cpp");

console.log("language.test.ts: all assertions passed");
