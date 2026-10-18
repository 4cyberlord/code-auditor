import assert from "node:assert/strict";
import { councilStageText, modelLamp } from "../src/lib/storyProgress.ts";

const code = { kind: "code" as const, code: "def solve(): pass", answer: "A working approach" };
assert.equal(modelLamp({ status: "queued", final: null }), "waiting");
assert.equal(modelLamp({ status: "streaming", final: null }), "waiting");
assert.equal(modelLamp({ status: "done", final: code }), "ready");
assert.equal(modelLamp({ status: "done", final: { ...code, code: "" } }), "issue",
  "a coding model is not green until it returns usable code");
assert.equal(modelLamp({ status: "done", final: null }), "issue");
assert.equal(modelLamp({ status: "error", final: null }), "issue");
assert.equal(modelLamp({ status: "cancelled", final: null }), "cancelled");
assert.match(councilStageText("verifying") ?? "", /executing candidates/i);
assert.match(councilStageText("synthesizing") ?? "", /final answer/i);
assert.match(councilStageText("porting") ?? "", /primary solution is ready/i);
assert.equal(councilStageText("idle"), null);
assert.equal(councilStageText("done"), null);

console.log("PASS: selected model lights and council progress reflect real run state");
