import { configuredCodeLanguage, type CodingLanguage } from "./primaryDeliveryPolicy.ts";

/**
 * Secondary language Councils are intentionally paused while Python's
 * question-fixture and executable-evidence path is hardened. See TODO.md.
 * Keeping the opt-in argument makes the existing implementation testable and
 * straightforward to re-enable after that work is complete.
 */
export const SECONDARY_LANGUAGE_COUNCILS_ENABLED = false;

/** Secondary Council rounds run only when explicitly enabled. */
export function secondaryCouncilLanguages(
  primary: string,
  available: readonly string[] | null | undefined,
  enabled = SECONDARY_LANGUAGE_COUNCILS_ENABLED,
): CodingLanguage[] {
  if (!enabled) return [];
  const origin = configuredCodeLanguage(primary);
  const seen = new Set<string>([origin]);
  const result: CodingLanguage[] = [];
  // Old cloud job snapshots have no saved language list. Regardless of
  // per-user preferences, every coding question supports all three rounds.
  for (const value of [...(Array.isArray(available) ? available : []), "python", "rust", "cpp"]) {
    const raw = String(value || "").trim().toLowerCase();
    if (!["python", "py", "python3", "rust", "rs", "cpp", "c++", "c++23"].includes(raw)) continue;
    const language = raw === "rs" ? "rust" : configuredCodeLanguage(raw);
    if (!seen.has(language)) {
      seen.add(language);
      result.push(language);
    }
  }
  return result;
}

/**
 * Carry the exact solver cohort selected for the primary Council into each
 * independent language round. The winning model is only a legacy fallback
 * when an older caller has no recorded solver cohort.
 */
export function independentLanguageSolverModels(
  selectedModels: readonly string[] | null | undefined,
  fallbackModel = "",
): string[] {
  const selected = [...new Set((Array.isArray(selectedModels) ? selectedModels : [])
    .map(model => String(model || "").trim())
    .filter(Boolean))];
  if (selected.length) return selected;
  const fallback = String(fallbackModel || "").trim();
  return fallback ? [fallback] : [];
}

/**
 * Secondary-language winners must be evaluated by independent judges, not
 * silently promoted only because one E2B run passed. A single configured
 * judge is the minimum on restricted rosters; otherwise require at least two.
 * Failed/invalid reports never count.
 */
export function independentJudgesReady(configured: number, accepted: number): boolean {
  if (!Number.isInteger(configured) || !Number.isInteger(accepted) || configured < 1 || accepted < 0)
    return false;
  return accepted >= Math.min(configured, 2);
}

export function independentLanguageInstruction(language: string): string {
  const id = configuredCodeLanguage(language);
  const label = id === "cpp" ? "C++23" : id === "rust" ? "Rust" : "Python 3";
  return [
    "NEW INDEPENDENT COUNCIL SOLVE — REQUIRED LANGUAGE: " + label + ".",
    "Solve the original programming question from scratch using your own algorithm.",
    "This is NOT a translation, port, rewrite or transcription of another solution.",
    "You have NOT been shown any previous winning source code. Do not infer its algorithm.",
    "Use only the actual question, its validated requirements and the selected language documentation.",
    "Meet the original callable signature or stdin/stdout interface for " + label + ".",
    "Return one complete <<<FINAL KIND: code LANGUAGE: " + id + " CODE: ... FINAL>>> answer.",
    "Explain the actual approach and justified time/auxiliary-space Big O.",
    "Do not claim execution passes or measured performance unless E2B actually ran.",
  ].join("\n");
}
/** Independent solves must never receive the previous winner, blueprint, or another candidate. */
export function independentLanguageQuestion(question: string, language: string, knowledge = ""): string {
  return [
    "ORIGINAL PROBLEM AND VERIFIED QUESTION EVIDENCE:\n" + String(question || ""),
    "REQUIRED LANGUAGE: " + configuredCodeLanguage(language),
    "Use a language-native algorithm. This is a fresh independent attempt, not a conversion.",
    knowledge.trim() ? "REFERENCE KNOWLEDGE (not source code):\n" + knowledge.trim() : "",
  ].filter(Boolean).join("\n\n");
}
