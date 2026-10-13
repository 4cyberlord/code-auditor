import assert from "node:assert/strict";
import { coordinatorCandidates, coordinatorPrompt, verifyCoordinatorAssignment } from "../src/lib/visionCoordinator.ts";

const approved = [
  {id:"kimi",model:"moonshotai/kimi-k3"},
  {id:"gpt",model:"openai/gpt-5-6-sol"},
  {id:"claude",model:"claude/opus-5-5"},
  {id:"gpt-copy",model:"gpt-5.6-sol"},
  {id:"alien",model:"other/model"},
  {id:"gemini",model:"google/gemini-3-1-pro"},
] as const;
assert.deepEqual(coordinatorCandidates(approved).map(x=>x.id),["gpt","claude","gemini"]);
assert.deepEqual(coordinatorCandidates([{id:"kimi",model:"moonshotai/kimi-k3"}]).map(x=>x.id),["kimi"]);
const prompt=coordinatorPrompt("Regex matching task",approved,5);
assert.ok(prompt.systemPrompt.includes("Do not transcribe"));
assert.ok(prompt.systemPrompt.includes("attached screenshots"));
assert.ok(prompt.userText.includes("screenshotCount"));
assert.equal(verifyCoordinatorAssignment('{"selected":["gpt","claude","alien"],"family":"string","reason":"Regex matching"}',approved)?.selected.length,2);
assert.equal(verifyCoordinatorAssignment('{"selected":["alien"]}',approved),null);
assert.equal(verifyCoordinatorAssignment("not-json",approved),null);
console.log("PASS: fixed-roster visual coordinator priority, no extraction, and strict agent ID validation");
