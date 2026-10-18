import assert from "node:assert/strict";
import { secondaryCouncilLanguages, independentLanguageSolverModels, independentLanguageInstruction, independentLanguageQuestion, independentJudgesReady } from "../src/lib/independentLanguageCouncil.ts";

assert.deepEqual(secondaryCouncilLanguages("python",["python","rust","cpp"]),[], "secondary-language work is paused while Python is stabilized");
assert.deepEqual(secondaryCouncilLanguages("python",["python","rust","cpp"],true),["rust","cpp"]);
assert.deepEqual(secondaryCouncilLanguages("rust",["python","rust","cpp"],true),["python","cpp"]);
assert.deepEqual(secondaryCouncilLanguages("cpp",["python","rust","cpp"],true),["python","rust"]);
assert.deepEqual(secondaryCouncilLanguages("Python",["javascript","python","py","c++","cpp","rs"],true),["cpp","rust"]);
assert.deepEqual(secondaryCouncilLanguages("python",["python"],true),["rust","cpp"]);
assert.deepEqual(secondaryCouncilLanguages("python",undefined,true),["rust","cpp"]);
assert.deepEqual(secondaryCouncilLanguages("rust",undefined,true),["python","cpp"]);
assert.deepEqual(independentLanguageSolverModels(["adaptive-b", "adaptive-d", "adaptive-b"], "winner-model"), ["adaptive-b", "adaptive-d"]);
assert.deepEqual(independentLanguageSolverModels([], "winner-model"), ["winner-model"]);
assert.deepEqual(independentLanguageSolverModels([], ""), []);
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
assert.equal(independentJudgesReady(4, 2), true);
assert.equal(independentJudgesReady(4, 1), false, "one of four judge reports is not a Council");
assert.equal(independentJudgesReady(2, 2), true);
assert.equal(independentJudgesReady(2, 0), false);
assert.equal(independentJudgesReady(1, 1), true, "legacy single-judge rosters are still supported");
assert.equal(independentJudgesReady(0, 0), false, "missing independent judge evidence cannot select a winner");
console.log("PASS: secondary languages each re-solve independently, honoring the primary setting");
