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
const DISTINCTIVE_IDEAS: Array<[string, RegExp]> = [
  ["hash", /\bhash(?:\s*[- ]?map| table)?\b|\bmap\b/i],
  ["prefix", /\bprefix(?:\s+sum)?\b/i],
  ["binary-search", /\bbinary\s+search\b/i],
  ["sorting", /\bsort(?:ing)?\b/i],
  ["heap", /\bheap\b|\bpriority queue\b/i],
  ["recursion", /\brecurs(?:ion|ive)\b/i],
  ["iteration", /\biterat(?:e|ion|ive)\b/i],
  ["sliding-window", /\bsliding\s+window\b/i],
  ["two-pointers", /\btwo\s+pointers?\b/i],
  ["dynamic-programming", /\bdynamic\s+programming\b|\b(?:memoization|tabulation)\b/i],
  ["trie", /\btrie\b/i],
  ["graph-search", /\b(?:bfs|dfs|breadth[- ]first|depth[- ]first)\b/i],
  ["union-find", /\b(?:union[- ]find|disjoint[- ]set)\b/i],
  ["monotonic", /\bmonotonic(?:\s+stack|\s+queue)?\b/i],
  ["partition", /\bpartition(?:ing)?\b/i],
  ["quickselect", /\bquickselect\b/i],
  ["allocation", /\b(?:allocation|allocations|allocate|allocating)\b/i],
  ["memory", /\bmemory\b/i],
  ["edge-case", /\bedge cases?\b/i],
];
/** Two judges must identify at least one same concrete improvement theme. */
export function corroboratedImprovementIdeas(ideas: string[]): string[] {
  const substantial = ideas.map(s => String(s || "").trim().slice(0, 800))
    .filter(s => s.length >= 18 && !NONE.test(s) && SUBSTANTIVE.test(s));
  if (substantial.length < 2) return [];
  const tagged = substantial.map(text => ({
    text,
    topics: new Set(DISTINCTIVE_IDEAS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)),
  }));
  const corroborated = tagged.filter((idea, index) => tagged.some((other, otherIndex) =>
    index !== otherIndex && [...idea.topics].some(topic => other.topics.has(topic))));
  return corroborated.length >= 2 ? corroborated.slice(0, 4).map(row => row.text) : [];
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
  requiredApprovals?: number;
}): boolean {
  const { priorRun, proposedRun, previousTime, previousSpace, approvals } = args;
  const required = Math.max(2, args.requiredApprovals ?? approvals.length);
  if (!priorRun.ran || !priorRun.ok || priorRun.failed !== 0 || priorRun.passed < 1 ||
    !proposedRun.ran || !proposedRun.ok || proposedRun.failed !== 0 ||
    proposedRun.passed < priorRun.passed || !proposedRun.codeDigest ||
    proposedRun.codeDigest === priorRun.codeDigest || approvals.length !== required) return false;
  const reviewers = approvals;
  if (reviewers.some(row => !row.accepted || row.reason.length < 12)) return false;
  for (const row of reviewers) {
    const time = compareComplexityBounds(row.time, previousTime).relation;
    const space = compareComplexityBounds(row.space, previousSpace).relation;
    if (!["equivalent", "left-no-worse"].includes(time) ||
      !["equivalent", "left-no-worse"].includes(space)) return false;
  }
  if (reviewers.some(row => compareComplexityBounds(row.time, reviewers[0].time).relation !== "equivalent" ||
    compareComplexityBounds(row.space, reviewers[0].space).relation !== "equivalent")) return false;
  return true;
}
