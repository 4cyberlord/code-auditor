import type { PropertyFixture } from "./propertyAssessment.ts";

/**
 * Reviewed, code-owned fixtures. Never derive expectations from model output,
 * OCR, generated harnesses, saved preferences, or council votes.
 * Entries must be matched against the EXACT canonical question text.
 */
export interface ReviewedPropertyCase {
  question: string;
  fixtures: readonly PropertyFixture[];
}
/** Intentionally empty until an operator reviews and commits fixture definitions. */
export const REVIEWED_PROPERTY_CASES: readonly ReviewedPropertyCase[] = [];

export function reviewedFixturesFor(question: string): readonly PropertyFixture[] {
  const match=REVIEWED_PROPERTY_CASES.find(c=>c.question===question);
  return match?.fixtures ?? [];
}
