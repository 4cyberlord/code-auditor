/** Coding Council publishes one verified primary answer before optional ports. */
export type CodingLanguage = "python" | "cpp" | "rust";
export function primaryCodingLanguage(problem: string): CodingLanguage {
  const text = String(problem || "").slice(0, 18000);
  const explicit = /(?:required|target|programming|implementation|output)\s*language\s*[:=]\s*(python|rust|c\+\+|cpp)(?=\s|$|[,.;:)])/i.exec(text)
    || /\b(?:implement|write|solve|code)\s+(?:this|it|the\s+solution|the\s+program)?\s*in\s+(python|rust|c\+\+|cpp)(?=\s|$|[,.;:)])/i.exec(text);
  const lang = explicit?.[1]?.toLowerCase();
  if (lang === "rust") return "rust";
  if (lang === "cpp" || lang === "c++") return "cpp";
  if (lang === "python") return "python";
  if (/#include\s*[<"]|\bstd::|\bclass\s+Solution\s*\{/.test(text)) return "cpp";
  if (/\bfn\s+main\s*\(|\bimpl\s+Solution\b/.test(text)) return "rust";
  return "python";
}
/** Supplied examples, review and winner verification remain the primary gate. */
export function primaryFirstInstruction(): string {
  return "For a coding question, solve and verify the primary language only. Use Python unless the problem explicitly requires C++ or Rust. Do not generate secondary-language code or test harnesses in this first answer. Return time and space Big O for the chosen algorithm. Other language equivalents follow only after an execution-verified winner is available.";
}
