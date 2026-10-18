/** The settings snapshot decides which language every initial solver receives. */
export type CodingLanguage = "python" | "cpp" | "rust";
export function configuredCodeLanguage(value: string | undefined): CodingLanguage {
  const normalized = String(value || "Python").trim().toLowerCase();
  return normalized === "rust" ? "rust" : (normalized === "cpp" || normalized === "c++" || normalized === "c++23") ? "cpp" : "python";
}
export function primaryCodingLanguage(problem: string, configured = "Python"): CodingLanguage {
  const text = String(problem || "").slice(0, 18000);
  // A required language/visible judge stub is part of the question's contract.
  // In its absence the user's Code in selection is authoritative.
  const explicit = /(?:required|target|programming|implementation|output)\s*language\s*[:=]\s*(python|rust|c\+\+|cpp)(?=\s|$|[,.;:)])/i.exec(text)
    || /\b(?:implement|write|solve|code)\s+(?:this|it|the\s+solution|the\s+program)?\s*in\s+(python|rust|c\+\+|cpp)(?=\s|$|[,.;:)])/i.exec(text);
  if (explicit) return configuredCodeLanguage(explicit[1]);
  if (/#include\s*[<"]|\bstd::|\bclass\s+Solution\s*\{/.test(text)) return "cpp";
  if (/\bfn\s+main\s*\(|\bimpl\s+Solution\b/.test(text)) return "rust";
  if (/\bdef\s+[a-z_]\w*\s*\(|\bclass\s+Solution\s*:\s*/.test(text)) return "python";
  return configuredCodeLanguage(configured);
}
export function primaryFirstInstruction(language: CodingLanguage): string {
  const label = language === "cpp" ? "C++23" : language === "rust" ? "Rust" : "Python";
  return "FIRST STAGE: Code in " + label + " only. This language was selected in Settings for this question. " +
    "Use the exact function signature / stdin interface required by the question. " +
    "All agents independently solve in this same primary language. " +
    "No other-language ports or port harnesses in this phase. " +
    "State the approach, accurate time and auxiliary-space Big O; only report measured runtimes when measured. " +
    "Other language versions follow only after E2B verification and Council selection.";
}
/** Judges see exactly what the question supplied, not AI-synthesized expected answers. */
export function providedTestBrief(cases: Array<{id:string;input:string;output:string}>): string {
  if (!cases.length) return "No unambiguous labelled examples were extracted. Do not invent expected outputs.";
  return [
    "QUESTION-PROVIDED TEST CASES (authoritative; actual E2B results remain the execution evidence):",
    ...cases.slice(0, 12).map(item => item.id + ": INPUT " + item.input.slice(0, 400) +
      " => EXPECTED OUTPUT " + item.output.slice(0, 400)),
    "Check interface, each expected output, edge-case coverage, code readability, language best practices, time O and space O. Do not treat source-only examples as evidence of passing hidden tests.",
  ].join("\n").slice(0, 6000);
}
