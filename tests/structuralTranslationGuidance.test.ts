import assert from "node:assert/strict";
import test from "node:test";
import { structuralLanguage, structuralTranslationGuidanceFor } from "../src/lib/structuralTranslationGuidance.ts";

test("normalizes the three structural-port languages", () => {
  assert.equal(structuralLanguage("Python 3"), null);
  assert.equal(structuralLanguage("py"), "python");
  assert.equal(structuralLanguage("C++"), "cpp");
  assert.equal(structuralLanguage("rs"), "rust");
});

test("supplies target-aware rules rather than a generic token replacement prompt", () => {
  const rust = structuralTranslationGuidanceFor("Python", "Rust");
  assert.match(rust, /Option<T>/);
  assert.match(rust, /Result<T, E>/);
  assert.match(rust, /usize only for proven indices/);

  const cpp = structuralTranslationGuidanceFor("rust", "c++");
  assert.match(cpp, /std::optional/);
  assert.match(cpp, /std::expected/);
  assert.match(cpp, /RAII/);
});

test("does not inject the dictionary for same or unsupported language pairs", () => {
  assert.equal(structuralTranslationGuidanceFor("python", "python"), "");
  assert.equal(structuralTranslationGuidanceFor("python", "javascript"), "");
});
