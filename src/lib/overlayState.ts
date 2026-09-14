import { agentSpec, type AgentId } from "./models.ts";
import type { AgentStatus } from "./store.ts";
import type { AgentFinal } from "./parse.ts";
import type { SolutionReview } from "./review.ts";
import type { CandidateRun, Presentation, TestSuite } from "./council.ts";

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
  /**
   * Why the answer above is trustworthy, in fields.
   *
   * The overlay's thought-process panes were empty because nothing was sending
   * anything to put in them. This is that: standing, approach, the per-candidate
   * evidence and the bench's dissent, already computed on the report.
   */
  presentation?: Presentation | null;
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
  /** The finished council's presentation, when a council produced one. */
  presentation?: Presentation | null;
  /** Round-1 runs, so the harness rows can show what actually happened. */
  runs?: Record<string, CandidateRun>;
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

/**
 * The harness rows.
 *
 * With a presentation in hand these become one row per candidate carrying what
 * its run actually did, which is the difference between a test pane that
 * reports evidence and one that says "Not run in overlay" five times. Without
 * one — a panel run, or a council that never executed anything — the old
 * per-suite placeholder is still the honest answer.
 */
function overlayTests(suites: TestSuite[] = [], presentation?: Presentation | null): OverlayTestState[] {
  if (presentation?.evidence?.length) {
    return presentation.evidence.slice(0, 8).map((row) => ({
      name: `Candidate ${row.letter}${row.revised ? " (revised)" : ""}`,
      input: row.model,
      expected: row.gate === "untested" ? "not executed" : `${row.passed + row.failed} case(s)`,
      actual:
        row.gate === "untested"
          ? row.note || "no run"
          : `${row.passed} passed, ${row.failed} failed${row.runtime ? ` · ${row.runtime}` : ""}`,
      status: row.gate === "pass" ? "passed" : row.gate === "fail" ? "failed" : "pending",
    }));
  }
  return suites.slice(0, 5).map((suite, index) => ({
    name: `Harness ${index + 1}`,
    input: suite.language,
    expected: "PASS lines",
    actual: "Not run in overlay",
    status: "pending",
  }));
}

/**
 * The council's own shipped answer, which outranks anything the panel holds.
 *
 * A council that ran to a verified winner has the better code by construction —
 * it was reviewed, revised, executed and gated — and the overlay was still
 * showing whichever pane happened to answer first.
 */
function councilSolution(input: BuildOverlayStateInput): OverlaySolutionState | null {
  const p = input.presentation;
  if (!p?.code?.trim()) return null;
  return {
    title: `solution${p.language ? `.${p.language}` : ""}`,
    language: p.language || "",
    code: p.code.trim(),
    source: p.provenance || "council",
    status: "reviewed",
  };
}

export function buildOverlayState(input: BuildOverlayStateInput): OverlayState {
  const solution = councilSolution(input) ?? reviewedSolution(input) ?? candidateSolution(input);
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
    tests: overlayTests(input.testSuites, input.presentation),
    presentation: input.presentation ?? null,
  };
}
