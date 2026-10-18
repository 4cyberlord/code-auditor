import type { CandidateReview, CandidateRun } from "./council.ts";
import {
  classifyExecutionFailure,
  mapCandidateFailureLocation,
  requiresRepair,
} from "../../scripts/lib/phase2Execution.mjs";

/** Maximum repair generations after the original candidate has been tested. */
export const MAX_CANDIDATE_REPAIR_ATTEMPTS = 3;

/** Attach evidence-based failure labels before deciding whether code needs repair. */
export function classifyCandidateRun(
  run: CandidateRun,
  sourceMap?: { startLine: number; endLine: number },
): CandidateRun {
  const failureLocation = mapCandidateFailureLocation(run.stderr, sourceMap);
  return {
    ...run,
    failureKind: classifyExecutionFailure({ run, sourceMap }),
    failureLocation,
  };
}

/**
 * A revision is expensive: it costs another model call and another sandbox
 * execution. Reviews remain valuable for the final decision, but a candidate
 * should only be rewritten when the evidence identifies a correctness risk.
 */
export function needsCandidateRevision(
  run: CandidateRun | undefined,
  reviews: readonly CandidateReview[]
): boolean {
  if (requiresRepair(run)) return true;
  return reviews.some(review => {
    if (review.correct === "no") return true;
    if (review.correct !== "unsure") return false;
    const problem = review.problems.trim().toLowerCase();
    return Boolean(problem) && !/^(none|no issue|n\/a|not applicable)$/i.test(problem);
  });
}
