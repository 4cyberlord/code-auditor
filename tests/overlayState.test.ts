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

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nall overlay state checks passed\n");
process.exit(failures ? 1 : 0);
