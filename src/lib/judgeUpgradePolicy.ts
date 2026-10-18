import type { CandidateRun } from "./council.ts";
import { compareComplexityBounds } from "./theoryBounds.ts";

export interface JudgeUpgradeVote {
  accepted: boolean;
  time: string;
  space: string;
  reason: string;
}
const SUBSTANTIVE = /\b(?:algorithm|approach|complexity|data structure|hash|prefix|binary|sort|heap|memory|recursion|iterat|linear|logarithm|optimized|optimization|refactor|edge case)\b/i;
const NONE = /^(?:none|no changes?|not needed|n\/a|already optimal|no material improvement)\.?$/i;
/** Only two independently written suggestions can launch an additional model pass. */
export function corroboratedImprovementIdeas(ideas: string[]): string[] {
  const substantial = ideas.map(s => String(s || "").trim().slice(0, 800))
    .filter(s => s.length >= 18 && !NONE.test(s) && SUBSTANTIVE.test(s));
  return substantial.length >= 2 ? substantial.slice(0, 4) : [];
}
export function parseJudgeUpgradeVote(text: string): JudgeUpgradeVote {
  const field = (name: string) => new RegExp("^" + name + "\\s*:\\s*(.+)$", "im").exec(text)?.[1]?.trim() || "";
  return {
    accepted: /^yes\b/i.test(field("ACCEPT")),
    time: field("TIME"),
    space: field("SPACE"),
    reason: field("BASIS").slice(0, 400),
  };
}
/**
 * Rerunning the original suite is mandatory, but cannot establish general
 * correctness. Independent reviewers must also corroborate that the upgraded
 * complexity is no worse on every comparable dimension.
 */
export function canAdoptJudgeUpgrade(args: {
  priorRun: CandidateRun;
  proposedRun: CandidateRun;
  previousTime: string;
  previousSpace: string;
  approvals: JudgeUpgradeVote[];
}): boolean {
  const { priorRun, proposedRun, previousTime, previousSpace, approvals } = args;
  if (!priorRun.ran || !priorRun.ok || priorRun.failed !== 0 || priorRun.passed < 1 ||
    !proposedRun.ran || !proposedRun.ok || proposedRun.failed !== 0 ||
    proposedRun.passed < priorRun.passed || !proposedRun.codeDigest ||
    proposedRun.codeDigest === priorRun.codeDigest || approvals.length < 2) return false;
  const reviewers = approvals.slice(0, 2);
  if (reviewers.some(row => !row.accepted || row.reason.length < 12)) return false;
  for (const row of reviewers) {
    const time = compareComplexityBounds(row.time, previousTime).relation;
    const space = compareComplexityBounds(row.space, previousSpace).relation;
    if (!["equivalent", "left-no-worse"].includes(time) ||
      !["equivalent", "left-no-worse"].includes(space)) return false;
  }
  if (compareComplexityBounds(reviewers[0].time, reviewers[1].time).relation !== "equivalent") return false;
  if (compareComplexityBounds(reviewers[0].space, reviewers[1].space).relation !== "equivalent") return false;
  return true;
}
