import { strict as assert } from "node:assert";
import { savedRunQuestion, savedRunTitle } from "../src/lib/historyPresentation.ts";
import type { RunDetail, RunSummary } from "../src/lib/sessions.ts";

const run: RunSummary = {
  id: "run-1", sessionId: "session-1", mode: "auto", asked: "",
  startedAt: "2026-10-13T13:00:00Z", finishedAt: "2026-10-13T13:01:00Z",
  answered: 4, verdict: "verified", reliability: "high",
};
const detail = {
  run,
  verdict: null,
  responses: [{ finalAnswer: "Return the k-th lexicographic permutation using factoradics." }],
  report: { council: {
    winner: "A",
    candidates: [{ letter: "A", final: { answer: "Construct the k-th permutation in lexicographic order using factoradics." } }],
    contract: { signature: "getPermutation(n, k)", inputs: "n and k", outputs: "permutation string" },
  } },
} as unknown as RunDetail;

assert.match(savedRunTitle(run, "Capture — 13 Oct", detail), /permutation/i);
assert.doesNotMatch(savedRunTitle(run, "Capture — 13 Oct", detail), /^Capture/);
assert.match(savedRunQuestion(detail), /getPermutation\(n, k\)/);
assert.match(savedRunQuestion(detail), /permutation string/);
assert.equal(savedRunQuestion({ ...detail, run: { ...run, asked: "Find the median" } }), "Find the median");
console.log("PASS: saved runs have task titles and recover their question context");
