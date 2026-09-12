import { agentSpec, type AgentId } from "./models.ts";
import type { AgentStatus } from "./store.ts";
import type { AgentFinal } from "./parse.ts";
import type { SolutionReview } from "./review.ts";
import type { TestSuite } from "./council.ts";

export type OverlayPhase = "idle" | "running" | "reviewing" | "done" | "error";

export interface OverlayAgentState {
  id: string;
  label: string;
  model: string;
  status: AgentStatus;
  error?: string;
  elapsedMs?: number;
}

export interface OverlaySolutionState {
  title: string;
  language: string;
  code: string;
  source: string;
  status: "candidate" | "reviewed";
}

export interface OverlayTestState {
  name: string;
  input: string;
  expected?: string;
  actual?: string;
  status: "pending" | "passed" | "failed";
}

export interface OverlayState {
  runId: string | null;
  updatedAt: string;
  phase: OverlayPhase;
  agents: OverlayAgentState[];
  solution: OverlaySolutionState | null;
  tests: OverlayTestState[];
}

export interface OverlayAgentInput {
  id: string;
  provider: AgentId;
  model: string;
  enabled: boolean;
  status: AgentStatus;
  error: string | null;
  elapsedMs: number | null;
  final: AgentFinal | null;
}

export interface BuildOverlayStateInput {
  runId: string | null;
  running: boolean;
  agents: OverlayAgentInput[];
  representative: string;
  review: {
    status: "idle" | "running" | "done" | "error";
    data: SolutionReview | null;
    language: string;
  };
  testSuites?: TestSuite[];
  now?: Date;
}

function overlayPhase(input: BuildOverlayStateInput, solution: OverlaySolutionState | null): OverlayPhase {
  if (input.running) return "running";
  if (input.review.status === "running") return "reviewing";
  if (solution) return "done";
  if (input.agents.some((a) => a.enabled && a.status === "error")) return "error";
  if (input.agents.some((a) => a.enabled && a.status !== "idle")) return "done";
  return "idle";
}

function reviewedSolution(input: BuildOverlayStateInput): OverlaySolutionState | null {
  const review = input.review.data;
  if (!review || input.review.status !== "done") return null;
  const preferred = input.review.language;
  const code = review.ports[preferred as keyof typeof review.ports] ?? Object.values(review.ports).find(Boolean);
  if (!code?.trim()) return null;
  return {
    title: `solution.${preferred || "txt"}`,
    language: preferred || "",
    code: code.trim(),
    source: "review",
    status: "reviewed",
  };
}

function candidateSolution(input: BuildOverlayStateInput): OverlaySolutionState | null {
  const answered = input.agents.filter((a) => a.enabled && a.final?.code?.trim());
  const pick =
    answered.find((a) => a.id === input.representative) ??
    answered.find((a) => a.final?.wellFormed) ??
    answered[0];
  if (!pick?.final?.code?.trim()) return null;
  const label = agentSpec(pick.provider).label;
  const language = pick.final.language || "";
  return {
    title: `${label} candidate${language ? `.${language}` : ""}`,
    language,
    code: pick.final.code.trim(),
    source: label,
    status: "candidate",
  };
}

function overlayTests(suites: TestSuite[] = []): OverlayTestState[] {
  return suites.slice(0, 5).map((suite, index) => ({
    name: `Harness ${index + 1}`,
    input: suite.language,
    expected: "PASS lines",
    actual: "Not run in overlay",
    status: "pending",
  }));
}

export function buildOverlayState(input: BuildOverlayStateInput): OverlayState {
  const solution = reviewedSolution(input) ?? candidateSolution(input);
  const agents = input.agents
    .filter((a) => a.enabled)
    .map((a) => {
      const out: OverlayAgentState = {
        id: a.id,
        label: agentSpec(a.provider).label,
        model: a.model,
        status: a.status,
      };
      if (a.error) out.error = a.error;
      if (a.elapsedMs != null) out.elapsedMs = a.elapsedMs;
      return out;
    });

  return {
    runId: input.runId,
    updatedAt: (input.now ?? new Date()).toISOString(),
    phase: overlayPhase(input, solution),
    agents,
    solution,
    tests: overlayTests(input.testSuites),
  };
}
