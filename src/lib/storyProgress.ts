import type { AgentStatus } from "./store.ts";
import type { CouncilPhase } from "./council.ts";

export type ModelLamp = "waiting" | "ready" | "issue" | "cancelled";

export interface ModelProgressInput {
  status: AgentStatus;
  final: {
    kind: "code" | "research" | "unknown";
    code: string;
    answer: string;
  } | null;
}

/** Green means usable final content, not merely a closed network stream. */
export function modelLamp(agent: ModelProgressInput): ModelLamp {
  if (agent.status === "error") return "issue";
  if (agent.status === "cancelled") return "cancelled";
  if (agent.status !== "done") return "waiting";
  if (!agent.final) return "issue";
  if (agent.final.kind === "code") return agent.final.code.trim() ? "ready" : "issue";
  return agent.final.code.trim() || agent.final.answer.trim() ? "ready" : "issue";
}

export function councilStageText(phase: CouncilPhase): string | null {
  switch (phase) {
    case "contracting": return "Council is confirming that every solver understood the same question.";
    case "solving": return "Council is gathering independent solution approaches.";
    case "speccing": return "Council is preparing test cases for the candidate solutions.";
    case "verifying": return "Council is executing candidates against the test cases.";
    case "reviewing": return "Council is checking correctness and theoretical complexity.";
    case "revising": return "Council is improving candidates flagged by the review.";
    case "reverifying": return "Council is retesting revised candidates.";
    case "judging": return "Council judges are comparing the tested solutions.";
    case "synthesizing": return "Council is preparing the final answer.";
    case "porting": return "Verified primary solution is ready; optional review and language versions continue in the background.";
    default: return null;
  }
}
