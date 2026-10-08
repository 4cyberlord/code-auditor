/**
 * Phase 6.5: conservative, auditable problem classification. This is a routing
 * hint, not a substitute for reading pixels or a guarantee of correctness.
 */
import type { Extraction } from "./extraction.ts";

export type ProblemFamily = "array" | "string" | "tree" | "graph" | "dynamic_programming" |
  "linked_list" | "heap" | "math" | "geometry" | "database" | "concurrency" |
  "greedy" | "backtracking" | "other";
export type ReadingPath = "standard" | "visual_review" | "ambiguity_review";
export type VerificationPlan = "exact_output" | "property_validator" | "specialized_validator";

export interface ProblemRouting {
  families: ProblemFamily[];
  path: ReadingPath;
  verification: VerificationPlan;
  /** Human-readable signals supporting this routing decision. */
  reasons: string[];
  /** Never infer unobserved structure from a screenshot's subject tag alone. */
  needsVisualStructure: boolean;
}

const PATTERNS: [ProblemFamily, RegExp][] = [
  ["tree", /\b(binary tree|bst|tree node|tree traversal|inorder|preorder|postorder|segment tree|binary indexed tree)\b/i],
  ["graph", /\b(graph|shortest path|topological sort|union.find|connected component|minimum spanning tree|dijkstra)\b/i],
  ["dynamic_programming", /\b(dynamic programming|memoiz|dp\[|knapsack|longest common subsequence)\b/i],
  ["linked_list", /\b(linked.list|listnode|merge k sorted lists)\b/i],
  ["heap", /\b(priority queue|heapq|binary heap)\b/i],
  ["array", /\b(array|subarray|prefix sum|two pointers|sliding window)\b/i],
  ["string", /\b(string|substring|palindrome|regex|pattern matching)\b/i],
  ["math", /\b(theorem|modulo|prime number|matrix|probability|combinatorics)\b/i],
  ["geometry", /\b(geometry|polygon|convex hull|coordinate plane|sweep line)\b/i],
  ["database", /\b(sql|database|query|join|table schema)\b/i],
  ["concurrency", /\b(concurrency|thread|mutex|deadlock|semaphore|race condition)\b/i],
  ["greedy", /\b(greedy|interval scheduling)\b/i],
  ["backtracking", /\b(backtracking|permutation|combinations|sudoku)\b/i],
];

export function routeProblem(extraction: Pick<Extraction,
  "problemSummary" | "observations" | "ambiguities" | "confidence" | "code" | "kind"
>): ProblemRouting {
  const content = [extraction.problemSummary, ...extraction.observations, extraction.code].join("\n");
  const families = PATTERNS.filter(([, rx]) => rx.test(content)).map(([name]) => name);
  if (!families.length) families.push("other");
  const visual = /\b(diagram|drawing|pictured|shown (above|below)|edge connecting|node connects|arrow from|visual layout|graph image|tree image|geometry figure|camera icon|icon placement)\b/i.test(content);
  const symbols = /\b(unreadable|illegible|cropped|truncated|ambiguous symbol|unclear notation)\b/i.test(content);
  const uncertain = extraction.ambiguities.length > 0 || !Number.isFinite(extraction.confidence) ||
    extraction.confidence < 0.7 || symbols;
  const reasons: string[] = [];
  if (visual) reasons.push("The reading references visual structure; OCR text alone may omit relationships.");
  if (uncertain) reasons.push("The extraction contains ambiguity or low confidence.");
  const multiOutput = /\b(multiple valid|more than one valid|any valid|any order|either .* accepted|another valid|all valid answers|in any order)\b/i.test(content);
  const specialized = /\b(interactive problem|interactive judge|randomized algorithm|concurrent execution|floating.point tolerance|precision error)\b/i.test(content);
  if (multiOutput) reasons.push("Several distinct outputs may satisfy the problem; avoid fixed expected-output equality.");
  return {
    families,
    path: uncertain ? "ambiguity_review" : visual ? "visual_review" : "standard",
    verification: specialized ? "specialized_validator" : multiOutput ? "property_validator" : "exact_output",
    reasons,
    needsVisualStructure: visual,
  };
}

export function routingGuidance(route: ProblemRouting): string {
  const lines = ["TASK CLASSIFICATION (provisional, not an answer)",
    "Problem families: " + route.families.join(", "),
    "Reading path: " + route.path,
    "Verification plan: " + route.verification];
  if (route.needsVisualStructure) lines.push("Check the original diagram's nodes, edges, orientation and symbols before trusting a text-only answer.");
  if (route.path === "ambiguity_review") lines.push("Resolve uncertainties against the source image; do not invent missing notation or constraints.");
  if (route.verification === "property_validator") lines.push("Validate required properties; a single example serialization may not be the only correct output.");
  return lines.concat(route.reasons).join("\n");
}
