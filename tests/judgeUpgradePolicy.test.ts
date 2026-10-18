import assert from "node:assert/strict";
import { corroboratedImprovementIdeas, parseJudgeUpgradeVote, canAdoptJudgeUpgrade } from "../src/lib/judgeUpgradePolicy.ts";
const ideas = corroboratedImprovementIdeas([
  "Replace sorting with a hash map to reach linear complexity.",
  "Candidate B's hash-map approach avoids the O(n log n) sort and unnecessary allocation.",
]);
assert.equal(ideas.length, 2);
assert.deepEqual(corroboratedImprovementIdeas(["none", "No change", "Optimize the algorithm"]), []);
const vote = parseJudgeUpgradeVote("ACCEPT: yes\nTIME: O(n)\nSPACE: O(n)\nBASIS: single map scan preserves all output semantics");
assert.equal(vote.accepted, true);
assert.equal(vote.time, "O(n)");
assert.equal(parseJudgeUpgradeVote("ACCEPT: no\nTIME: UNKNOWN\nSPACE: UNKNOWN").accepted, false);
const prior = { letter: "A", ran: true, ok: true, passed: 4, failed: 0, codeDigest: "orig", durationMs: 4, runtime: "python", note: "" };
const proposed = { ...prior, codeDigest: "new", durationMs: 3 };
const accepted = { priorRun: prior, proposedRun: proposed, previousTime: "O(n log n)", previousSpace: "O(n)", approvals: [vote, vote] };
assert.equal(canAdoptJudgeUpgrade(accepted), true);
assert.equal(canAdoptJudgeUpgrade({...accepted, approvals:[vote]}), false);
assert.equal(canAdoptJudgeUpgrade({...accepted, proposedRun:{...proposed, failed:1,ok:false}}), false);
assert.equal(canAdoptJudgeUpgrade({...accepted, proposedRun:{...proposed, passed:2}}), false);
assert.equal(canAdoptJudgeUpgrade({...accepted, proposedRun:{...proposed, codeDigest:"orig"}}), false);
assert.equal(canAdoptJudgeUpgrade({...accepted, approvals:[vote,{...vote,time:"O(n^2)"}]}), false);
assert.equal(canAdoptJudgeUpgrade({...accepted, approvals:[vote,{...vote,accepted:false}]}), false);
console.log("PASS: judge code upgrades need consensus, E2B proof and corroborated no-worse complexity");
