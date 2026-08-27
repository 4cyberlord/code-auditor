import assert from "node:assert/strict";
import {
  harnessIsSuspect,
  enforceWinnerGate,
  gateFor,
  endpointForCouncilModel,
  canModelSee,
  partitionByVision,
  looksLikeCodingProblem,
  reachableSeats,
  answerStanding,
  rejectedImages,
  reasoningForModel,
  reasoningFields,
  rejectedReasoning,
  COUNCIL_DEFAULT_JUDGES,
  COUNCIL_DEFAULT_MODELS,
} from "../src/lib/council.ts";
import { formatMemory, solutionPolicy } from "../src/lib/prompts.ts";

const run = (letter: string, over: Record<string, unknown> = {}) =>
  ({ letter, ran: true, ok: false, passed: 0, failed: 0, durationMs: 1, note: "", runtime: "x", ...over }) as never;

// --------------------------------------------------------------- the gate

// The lc4 failure, exactly: synthesis named A, whose program never started.
{
  const runs = {
    A: run("A", { ran: true, ok: false, passed: 0, failed: 0, note: "exit 1" }),
    B: run("B", { ran: true, ok: false, passed: 18, failed: 1, note: "exit 1" }),
  };
  const ruling = enforceWinnerGate("A", runs);
  assert.equal(ruling.winner, "", "a candidate whose run failed cannot win");
  assert.match(ruling.overruledReason, /Execution outranks agreement/);
}

// A winner that genuinely passed survives untouched.
{
  const runs = { A: run("A", { ok: true, passed: 12, failed: 0 }) };
  assert.equal(gateFor(runs.A), "pass");
  assert.deepEqual(enforceWinnerGate("A", runs), { winner: "A", overruledReason: "" });
}

// Lowercase and whitespace from a model's prose still resolve.
assert.equal(enforceWinnerGate(" b ", { B: run("B", { ok: true, passed: 3, failed: 0 }) }).winner, "B");

// No winner in, no winner out — and no invented complaint.
assert.deepEqual(enforceWinnerGate("", {}), { winner: "", overruledReason: "" });

// The exception that matters: an MCQ or maths answer executes nothing. A gate
// with no evidence behind it must not veto the result.
{
  const runs = { A: run("A", { ran: false, note: "no code" }) };
  assert.equal(enforceWinnerGate("A", runs).winner, "A", "silence is not failure");
}

// A candidate that exited 0 but printed no PASS lines proves nothing, so it
// cannot win either — that is gateFor's "untested", not a pass.
{
  const runs = {
    A: run("A", { ok: true, passed: 0, failed: 0 }),
    B: run("B", { ok: true, passed: 5, failed: 0 }),
  };
  assert.equal(gateFor(runs.A), "untested");
  assert.equal(enforceWinnerGate("A", runs).winner, "");
}

// ------------------------------------------------------- harness suspicion

// Two independent candidates, identical score, both failing: suspect the test.
{
  const reason = harnessIsSuspect({
    B: run("B", { passed: 18, failed: 1 }),
    D: run("D", { passed: 18, failed: 1 }),
  });
  assert.match(reason, /B, D/);
  assert.match(reason, /18 passed, 1 failed/);
}

// A candidate that never reached a test has no score to agree with anyone
// about, so it neither triggers nor blocks the signal.
{
  const reason = harnessIsSuspect({
    A: run("A", { passed: 0, failed: 0, note: "exit 1" }),
    B: run("B", { passed: 18, failed: 1 }),
    D: run("D", { passed: 18, failed: 1 }),
  });
  assert.match(reason, /B, D/, "A is excluded, B and D still agree");
}

// Different scores means they failed for their own reasons. No signal.
assert.equal(harnessIsSuspect({ B: run("B", { passed: 18, failed: 1 }), D: run("D", { passed: 12, failed: 7 }) }), "");

// One candidate cannot corroborate itself.
assert.equal(harnessIsSuspect({ B: run("B", { passed: 18, failed: 1 }) }), "");

// All passing is not suspicious, however identical.
assert.equal(harnessIsSuspect({ B: run("B", { ok: true, passed: 19, failed: 0 }), D: run("D", { ok: true, passed: 19, failed: 0 }) }), "");

// Nothing ran at all.
assert.equal(harnessIsSuspect({}), "");

// ------------------------------------------------------- which wire a model uses

// This list lived in two files with nothing keeping them equal. These
// assertions are the mechanism that now does.
{
  assert.equal(endpointForCouncilModel(undefined, "openai/gpt-5.6-sol"), "responses");
  assert.equal(endpointForCouncilModel(undefined, "openai/gpt-5.3-codex"), "responses");
  assert.equal(endpointForCouncilModel(undefined, "anthropic/claude-opus-5"), "chat");
  assert.equal(endpointForCouncilModel(undefined, "z-ai/glm-5.3"), "chat");
  assert.equal(endpointForCouncilModel(undefined, ""), "chat");
  assert.equal(endpointForCouncilModel(undefined, "  "), "chat");

  // A roster entry is the user's own statement about a seat, so it wins over
  // the fallback list in both directions.
  assert.equal(
    endpointForCouncilModel([{ id: "openai/gpt-5.6-sol", endpoint: "chat" }], "openai/gpt-5.6-sol"),
    "chat",
    "the roster can say a known-Responses model speaks chat"
  );
  assert.equal(
    endpointForCouncilModel([{ id: "some/new-model", endpoint: "responses" }], "some/new-model"),
    "responses",
    "and can classify a model the fallback list has never heard of"
  );

  // An empty roster is not a statement; fall back rather than defaulting to chat.
  assert.equal(endpointForCouncilModel([], "openai/gpt-5.6-sol"), "responses");

  // Every judge on the shipped bench must resolve to a wire the worker speaks.
  for (const seat of COUNCIL_DEFAULT_JUDGES) {
    const wire = endpointForCouncilModel(COUNCIL_DEFAULT_MODELS, seat.model);
    assert.ok(wire === "chat" || wire === "responses", `${seat.model} resolved to ${wire}`);
  }
}

// ------------------------------------------------- what the key can reach

{
  const seats = [{ id: "a/one" }, { id: "b/two" }, { id: "c/three" }];

  // A catalogue nobody has fetched yet disqualifies nothing. "We have not
  // asked" and "there is nothing there" must not read the same.
  assert.equal(reachableSeats(seats, (s) => s.id, undefined).reachable.length, 3);
  assert.equal(reachableSeats(seats, (s) => s.id, []).reachable.length, 3);
  assert.equal(reachableSeats(seats, (s) => s.id, []).unreachable.length, 0);

  const { reachable, unreachable } = reachableSeats(seats, (s) => s.id, ["a/one", "c/three", "z/unused"]);
  assert.deepEqual(reachable.map((s) => s.id), ["a/one", "c/three"]);
  assert.deepEqual(unreachable.map((s) => s.id), ["b/two"], "a seat the key cannot reach is dropped, not tried");

  // Judges are keyed differently from solvers, and both go through this.
  const judges = [{ model: "openai/gpt-5.6-sol" }, { model: "gone/model" }];
  assert.deepEqual(
    reachableSeats(judges, (j) => j.model, ["openai/gpt-5.6-sol"]).unreachable.map((j) => j.model),
    ["gone/model"]
  );
}

// ------------------------------------------------- who gets shown the picture

{
  // A measured probe beats everything: it is the only evidence an image
  // actually travelled this route.
  assert.equal(canModelSee({ "x/y": { vision: true } }, [{ id: "x/y", vision: false }], "x/y"), true);
  assert.equal(canModelSee({ "x/y": { vision: false } }, [{ id: "x/y", vision: true }], "x/y"), false);

  // Then the roster, which is the user's own statement about a seat.
  assert.equal(canModelSee({}, [{ id: "x/y", vision: false }], "x/y"), false);
  assert.equal(canModelSee(undefined, [{ id: "google/gemini-3.7-flash", vision: true }], "google/gemini-3.7-flash"), true);

  // Then the known-blind list, so a route measured once is not measured again.
  assert.equal(canModelSee(undefined, undefined, "google/gemini-3.7-flash"), false);

  // A model nobody has classified is assumed to see — the alternative is a new
  // seat that silently never participates and nobody can tell why.
  assert.equal(canModelSee(undefined, undefined, "some/brand-new-model"), true);
  assert.equal(canModelSee(undefined, undefined, ""), false);

  const { seeing, resting } = partitionByVision(
    [{ id: "a/sees" }, { id: "google/gemini-3.7-flash" }, { id: "b/sees" }],
    (m) => m.id,
    undefined,
    undefined
  );
  assert.deepEqual(seeing.map((m) => m.id), ["a/sees", "b/sees"]);
  assert.deepEqual(resting.map((m) => m.id), ["google/gemini-3.7-flash"]);
}

// ----------------------------------------------------- is it a coding problem

assert.equal(looksLikeCodingProblem([{ final: { kind: "code", code: "int main(){}" } }] as never), true);
assert.equal(looksLikeCodingProblem([{ final: { kind: "code", code: "   " } }] as never), false, "an empty block is not code");
assert.equal(looksLikeCodingProblem([{ final: { kind: "research" } }] as never), false);
assert.equal(looksLikeCodingProblem([{ final: null }, { final: { kind: "code", code: "x" } }] as never), true);
assert.equal(looksLikeCodingProblem([]), false);

// ------------------------------------------------------------- memory figures

assert.equal(formatMemory(20 * 1024), "20 MB");
assert.equal(formatMemory(1024), "1 MB");
assert.equal(formatMemory(512), "512 KB");
assert.equal(formatMemory(1536), "1.5 MB");
assert.match(solutionPolicy(["C++", "Python"], 20 * 1024), /20 MB/);
assert.match(solutionPolicy(["C++", "Python"], 20 * 1024), /rounds to 0ms/);

// ------------------------------------------------------- thinking before answering

{
  // On, and high, unless something says otherwise.
  assert.equal(reasoningForModel(undefined, "any/model"), "high");
  assert.equal(reasoningForModel({}, "any/model"), "high");

  // The setting turns it down globally...
  assert.equal(reasoningForModel({ reasoningEffort: "low" }, "any/model"), "low");
  assert.equal(reasoningForModel({ reasoningEffort: "off" }, "any/model"), "off");
  // ...and rubbish in the setting falls back rather than disabling thinking.
  assert.equal(reasoningForModel({ reasoningEffort: "banana" }, "any/model"), "high");

  // A seat outranks the setting, in both directions.
  assert.equal(
    reasoningForModel({ reasoningEffort: "off", councilModels: [{ id: "a/b", reasoning: "high" }] }, "a/b"),
    "high"
  );
  assert.equal(
    reasoningForModel({ reasoningEffort: "high", councilModels: [{ id: "a/b", reasoning: "off" }] }, "a/b"),
    "off"
  );

  // The two wires spell it differently and neither accepts the other's spelling.
  assert.deepEqual(reasoningFields("high", "chat"), { reasoning_effort: "high" });
  assert.deepEqual(reasoningFields("high", "responses"), { reasoning: { effort: "high" } });
  assert.deepEqual(reasoningFields("off", "chat"), {}, "off adds nothing to the body");
  assert.deepEqual(reasoningFields("off", "responses"), {});
}

// A route with no reasoning mode says so, and saying so is not a dead seat.
for (const complaint of [
  "Unsupported parameter: 'reasoning_effort'",
  "Unrecognized request argument supplied: reasoning",
  "model does not support reasoning",
  "Invalid value for reasoning_effort",
  "extra fields not permitted: reasoning",
]) {
  assert.equal(rejectedReasoning(complaint), true, complaint);
}
// Real failures must not be mistaken for it, or a dead route looks like a
// parameter problem and gets retried forever.
for (const other of [
  "429 Too Many Requests",
  "insufficient_user_quota",
  "model_not_found",
  "",
  "the judges' reasoning was sound",
]) {
  assert.equal(rejectedReasoning(other), false, other);
}

// ------------------------------- what the run may claim about its own answer

{
  // The lc4 shape exactly: every candidate failed, the synthesis wrote
  // "WINNER: NONE", and the gate had nothing to overrule — while the FINAL
  // ANSWER shipped a rejected candidate's logic anyway.
  const allFailed = { A: run("A", { note: "exit 1" }), B: run("B", { passed: 18, failed: 1 }) };
  const s1 = answerStanding("", allFailed);
  assert.equal(s1.standing, "unverified", "an empty winner must not read as a clean bill of health");
  assert.match(s1.reason, /Nothing here has been shown to work/);

  // A winner whose program actually passed.
  const s2 = answerStanding("A", { A: run("A", { ok: true, passed: 12, failed: 0 }) });
  assert.equal(s2.standing, "verified");
  assert.match(s2.reason, /passed 12/);

  // Something passed, but the synthesis named nobody — point at the one that did.
  const s3 = answerStanding("", {
    A: run("A", { note: "exit 1" }),
    B: run("B", { ok: true, passed: 9, failed: 0 }),
  });
  assert.equal(s3.standing, "unverified");
  assert.match(s3.reason, /Candidate\(s\) B did pass/);

  // Nothing ran at all: an MCQ or a research answer. Not a failure, and
  // crying wolf here would train the warning out of meaning anything.
  const s4 = answerStanding("A", {
    A: { letter: "A", ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: "no code", runtime: "" } as never,
  });
  assert.equal(s4.standing, "unexecuted");

  // A named winner that failed is unverified, not verified-with-a-caveat.
  assert.equal(answerStanding("A", allFailed).standing, "unverified");
}

// ------------------------------------------ a route that refuses the picture

for (const complaint of [
  "This model does not support image input",
  "Unsupported content type: image_url",
  "invalid message: image is not supported by this model",
  "model is text-only",
  "vision is not supported",
]) {
  assert.equal(rejectedImages(complaint), true, complaint);
}
// A route that is merely busy, broke or missing has not told us anything about
// images, and must not be marked blind for the rest of the run.
for (const other of ["429 Too Many Requests", "model_not_found", "insufficient_user_quota", "", "request timed out"]) {
  assert.equal(rejectedImages(other), false, other);
}

console.log("gate.test.ts: all assertions passed");
