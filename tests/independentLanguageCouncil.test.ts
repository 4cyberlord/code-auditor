import assert from "node:assert/strict";
import { secondaryCouncilLanguages, independentLanguageInstruction, independentLanguageQuestion } from "../src/lib/independentLanguageCouncil.ts";

assert.deepEqual(secondaryCouncilLanguages("python",["python","rust","cpp"]),["rust","cpp"]);
assert.deepEqual(secondaryCouncilLanguages("rust",["python","rust","cpp"]),["python","cpp"]);
assert.deepEqual(secondaryCouncilLanguages("cpp",["python","rust","cpp"]),["python","rust"]);
assert.deepEqual(secondaryCouncilLanguages("Python",["javascript","python","py","c++","cpp","rs"]),["cpp","rust"]);
assert.deepEqual(secondaryCouncilLanguages("python",["python"]),["rust","cpp"]);
assert.deepEqual(secondaryCouncilLanguages("python",undefined),["rust","cpp"]);
assert.deepEqual(secondaryCouncilLanguages("rust",undefined),["python","cpp"]);
const problem="Return the sum of n integers.";
for (const language of ["python","rust","cpp"]) {
  const instruction=independentLanguageInstruction(language);
  const prompt=independentLanguageQuestion(problem,language);
  assert.match(instruction,/Solve the original programming question from scratch/);
  assert.match(instruction,/NOT a translation/);
  assert.ok(prompt.includes(problem));
  assert.ok(prompt.includes("fresh independent attempt"));
  assert.ok(!prompt.includes("VERIFIED SOURCE"));
  assert.ok(!prompt.includes("winning code"));
  assert.ok(!prompt.includes("semantic blueprint"));
}
assert.match(independentLanguageInstruction("cpp"),/C\+\+23/);
console.log("PASS: secondary languages each re-solve independently, honoring the primary setting");
