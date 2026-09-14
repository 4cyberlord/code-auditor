import { buildOverlayState } from "../src/lib/overlayState.ts";
import { parseFinal } from "../src/lib/parse.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};

const finalText = `<<<FINAL
KIND: code
LANGUAGE: python
ANSWER: Use a hash map.
COMPLEXITY: O(n) time, O(n) space
CONFIDENCE: 0.9
CLAIMS:
- One pass
CODE:
\`\`\`python
def two_sum(nums, target):
    return []
\`\`\`
FINAL>>>`;

console.log("\n1. active agents become overlay chips");
{
  const state = buildOverlayState({
    runId: "run-1",
    running: true,
    representative: "",
    now: new Date("2026-09-11T12:00:00Z"),
    review: { status: "idle", data: null, language: "python" },
    agents: [
      {
        id: "openai",
        provider: "openai",
        model: "gpt-demo",
        enabled: true,
        status: "streaming",
        error: null,
        elapsedMs: null,
        final: null,
      },
      {
        id: "gemini",
        provider: "gemini",
        model: "gemini-demo",
        enabled: false,
        status: "idle",
        error: null,
        elapsedMs: null,
        final: null,
      },
    ],
  });
  check("running phase", state.phase === "running", state.phase);
  check("only enabled agents", state.agents.length === 1, String(state.agents.length));
  check("label from catalogue", state.agents[0]?.label === "GPT", state.agents[0]?.label);
}

console.log("\n2. candidate code is selected from representative");
{
  const state = buildOverlayState({
    runId: "run-2",
    running: false,
    representative: "openai",
    now: new Date("2026-09-11T12:00:00Z"),
    review: { status: "idle", data: null, language: "python" },
    agents: [
      {
        id: "openai",
        provider: "openai",
        model: "gpt-demo",
        enabled: true,
        status: "done",
        error: null,
        elapsedMs: 1200,
        final: parseFinal(finalText),
      },
    ],
  });
  check("done phase", state.phase === "done", state.phase);
  check("candidate solution present", state.solution?.status === "candidate", state.solution?.status);
  check("code included", Boolean(state.solution?.code.includes("def two_sum")));
}

console.log("\n3. reviewed ports outrank candidate code");
{
  const state = buildOverlayState({
    runId: "run-3",
    running: false,
    representative: "openai",
    now: new Date("2026-09-11T12:00:00Z"),
    review: {
      status: "done",
      language: "python",
      data: {
        valid: true,
        validNote: "",
        approach: { current: "", suggested: "", keyIdea: "" },
        efficiency: { currentTime: "", currentSpace: "", suggestedTime: "", suggestedSpace: "", note: "" },
        style: { readability: "", structure: "", note: "" },
        ports: { python: "print('reviewed')" },
      },
    },
    agents: [
      {
        id: "openai",
        provider: "openai",
        model: "gpt-demo",
        enabled: true,
        status: "done",
        error: null,
        elapsedMs: null,
        final: parseFinal(finalText),
      },
    ],
  });
  check("reviewed solution wins", state.solution?.status === "reviewed", state.solution?.status);
  check("reviewed code used", state.solution?.code === "print('reviewed')", state.solution?.code);
}

console.log("\n4. a finished council outranks the panel, and fills the evidence pane");
{
  const state = buildOverlayState({
    runId: "run-4",
    running: false,
    representative: "",
    now: new Date("2026-09-11T12:00:00Z"),
    review: { status: "idle", data: null, language: "python" },
    agents: [
      {
        id: "openai",
        provider: "openai",
        model: "gpt-demo",
        enabled: true,
        status: "done",
        error: null,
        elapsedMs: null,
        final: parseFinal(finalText),
      },
    ],
    testSuites: [{ language: "python", harness: "<<<SOLUTION>>>" }],
    presentation: {
      standing: "verified",
      standingReason: "Candidate B passed 19 generated test case(s) before being selected.",
      winner: "B",
      winnerSource: "judges",
      provenance: "Candidate B — z-ai/glm-5.3",
      approach: "one pass with a hash map",
      complexity: "O(n) time",
      evidence: [
        {
          letter: "A",
          model: "m-a",
          gate: "fail",
          passed: 17,
          failed: 2,
          revised: false,
          runtime: "node 22",
          durationMs: 30,
          elapsedMs: null,
          peakMemoryKb: null,
          note: "",
          judgePoints: 1,
        },
        {
          letter: "B",
          model: "z-ai/glm-5.3",
          gate: "pass",
          passed: 19,
          failed: 0,
          revised: true,
          runtime: "node 22",
          durationMs: 41,
          elapsedMs: null,
          peakMemoryKb: null,
          note: "",
          judgePoints: 2,
        },
      ],
      dissent: ["j-2 (performance) ranked Candidate A first; the execution gate rejected Candidate A."],
      rejected: ["A - two cases failed"],
      harnessSuspect: "",
      contractDisputes: [],
      code: "def two_sum(nums, target):\n    return [0, 1]",
      language: "python",
    },
  });
  // The council's answer was reviewed, revised, executed and gated. The panel's
  // was none of those, and the overlay was showing it anyway.
  check("the council's code is what the overlay shows", state.solution?.code.includes("[0, 1]") === true, state.solution?.code);
  check("and it is attributed", state.solution?.source.includes("z-ai/glm-5.3") === true, state.solution?.source);
  check("the test pane reports real runs", state.tests.length === 2 && state.tests[1].status === "passed", JSON.stringify(state.tests));
  check("a failing candidate reads as failing", state.tests[0].status === "failed", JSON.stringify(state.tests[0]));
  check("the dossier travels with the state", state.presentation?.dissent.length === 1, JSON.stringify(state.presentation?.dissent));
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nall overlay state checks passed\n");
process.exit(failures ? 1 : 0);
