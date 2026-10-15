import type { AgentFinal } from "./parse.ts";
import { gateFor, type Candidate, type CandidateRun } from "./council.ts";

/** Keep one coherent source for the code and its execution evidence.
 * An unrelated benchmark must never be shown as a measurement of this code. */
export interface VisibleSolver {
  id: string;
  model: string;
  enabled: boolean;
  status: "idle" | "queued" | "streaming" | "done" | "error" | "cancelled";
  final: AgentFinal | null;
}
export interface CouncilSolutionEvidence {
  phase: string;
  winner: string;
  candidates: readonly Candidate[];
  runs: Record<string, CandidateRun>;
  revisedRuns: Record<string, CandidateRun>;
  error: string | null;
}
export interface DisplaySolution {
  source: string;
  code: string;
  language: string;
  answer: string;
  complexity: string;
  benchmark: CandidateRun | null;
  provisional: boolean;
}
const toDisplay = (final: AgentFinal, source: string, benchmark: CandidateRun | null,
  provisional: boolean): DisplaySolution => ({
  source, code: final.code.trim(), language: final.language || final.raw.match(/```([a-zA-Z0-9+#._-]+)/)?.[1] || "",
  answer: final.answer, complexity: final.complexity,
  benchmark, provisional,
});
export function selectStorySolution(
  agents: readonly VisibleSolver[],
  council: CouncilSolutionEvidence,
  representative?: string | null,
): DisplaySolution | null {
  if ((council.phase === "done" || council.phase === "porting") && council.winner) {
    const winner = council.candidates.find(c => c.letter === council.winner);
    const final = winner?.revised?.code?.trim() ? winner.revised : winner?.final;
    if (final?.code?.trim()) {
      const benchmark = winner?.revised?.code?.trim()
        ? council.revisedRuns[winner.letter] ?? null
        : council.runs[winner!.letter] ?? null;
      if (gateFor(benchmark) !== "pass") return null;
      return toDisplay(final, winner!.model, benchmark, false);
    }
  }
  // Solver panes are candidates, not answers. Keep the solution area empty
  // until Council has selected a candidate that passed executable verification.
  // Progress and agent state remain visible elsewhere in the workspace.
  return null;
}

/** A coding result is publishable only when this exact code passed execution. */
export function selectVerifiedStorySolution(
  agents: readonly VisibleSolver[],
  council: CouncilSolutionEvidence,
  representative?: string | null,
): DisplaySolution | null {
  if (council.phase !== "done" && council.phase !== "porting") return null;
  const report = selectStorySolution(agents, council, representative);
  return report?.benchmark && gateFor(report.benchmark) === "pass" && !report.provisional
    ? report : null;
}

export interface FunctionSignature { name: string; signature: string }
export function extractFunctionSignatures(code: string): FunctionSignature[] {
  const found: FunctionSignature[] = [], seen = new Set<string>();
  // Bounded, line-oriented inspection: no guessed semantic explanation.
  for (const line of code.slice(0, 100_000).split("\n")) {
    const trimmed = line.trim();
    const match =
      /^(?:async\s+)?def\s+([\w]+)\s*\(([^)]*)\)/.exec(trimmed) ||
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([\w]+)\s*\(([^)]*)\)/.exec(trimmed) ||
      /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([\w]+)\s*\(([^)]*)\)/.exec(trimmed) ||
      /^func\s+(?:\([^)]*\)\s*)?([\w]+)\s*\(([^)]*)\)/.exec(trimmed) ||
      /^(?:(?:public|private|protected|static|final|inline|constexpr|virtual)\s+)*(?:[\w<>:*&,\[\]]+\s+)+([\w]+)\s*\(([^)]*)\)\s*(?:\{|const\b|->|$)/.exec(trimmed);
    if (!match || seen.has(match[1])) continue;
    const name=match[1];
    if (["if","for","while","switch","catch"].includes(name)) continue;
    seen.add(name); found.push({name, signature: name + "(" + match[2].trim() + ")"});
    if (found.length >= 12) break;
  }
  return found;
}
