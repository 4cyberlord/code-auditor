/**
 * Which language the answer comes back in.
 *
 * The rule is that the answer matches the question. Someone who photographs a
 * Python function wants Python back — a correct C++ rewrite is a different
 * answer to a question they did not ask, and it cannot be pasted where the
 * screenshot came from.
 *
 * This is deliberately separate from what the *benchmark* compiles. Timing a
 * C++ build of the same algorithm is evidence about the algorithm; it is not
 * the deliverable, and conflating the two is how a Django bug report comes back
 * as a C++ program with an excellent runtime.
 *
 * Pure, so the rule can be tested without a model in the loop.
 */

/** The setting value meaning "whatever the question was written in". */
export const MATCH_THE_QUESTION = "";

/**
 * Names people write versus what the runner needs.
 *
 * Only aliases that actually turn up: what a vision model calls a language in a
 * transcription, and what someone types into a settings box. Anything unknown
 * passes through untouched rather than being guessed at — a language this table
 * has not heard of is far more likely to be real than to be a typo.
 */
const ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  js: "javascript",
  node: "javascript",
  nodejs: "javascript",
  ts: "typescript",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  golang: "go",
  rs: "rust",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  "c#": "csharp",
  cs: "csharp",
  kt: "kotlin",
  yml: "yaml",
};

/** How a language is spelled when we say it back to a person or a model. */
const DISPLAY: Record<string, string> = {
  cpp: "C++",
  c: "C",
  csharp: "C#",
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  java: "Java",
  go: "Go",
  rust: "Rust",
  ruby: "Ruby",
  php: "PHP",
  bash: "Bash",
  sql: "SQL",
  swift: "Swift",
  kotlin: "Kotlin",
  dart: "Dart",
  scala: "Scala",
  r: "R",
};

/** Lowercased, trimmed, and de-aliased. `""` when there is nothing to normalise. */
export function normalizeLanguage(raw: string): string {
  const key = (raw ?? "").trim().toLowerCase().replace(/^\.+/, "");
  if (!key) return "";
  // "python 3.12" and "c++20" are what transcriptions actually contain.
  const head = key.split(/[\s,(/]/)[0].replace(/[0-9.]+$/, "") || key;
  return ALIASES[key] ?? ALIASES[head] ?? head ?? key;
}

/** The human spelling, for a prompt or a label. */
export function displayLanguage(raw: string): string {
  const norm = normalizeLanguage(raw);
  if (!norm) return "";
  return DISPLAY[norm] ?? norm.charAt(0).toUpperCase() + norm.slice(1);
}

export interface AnswerLanguage {
  /** Normalised id, or "" when nothing could be determined. */
  id: string;
  /** How to spell it at a model. */
  display: string;
  /** Why it was chosen — for the UI, so a surprising answer is explainable. */
  source: "setting" | "detected" | "unknown";
}

/**
 * Resolves the language the answer should be written in.
 *
 * A configured setting always wins: it is the one signal that came from a
 * person rather than from a transcription, and someone who has set it has said
 * they want it regardless of what the screenshot happened to contain.
 */
export function resolveAnswerLanguage(setting: string, detected: string): AnswerLanguage {
  const forced = normalizeLanguage(setting);
  if (forced) return { id: forced, display: displayLanguage(forced), source: "setting" };

  const found = normalizeLanguage(detected);
  if (found) return { id: found, display: displayLanguage(found), source: "detected" };

  return { id: "", display: "", source: "unknown" };
}

/**
 * The instruction handed to every solver.
 *
 * Worded as a constraint on the *deliverable* rather than a hint, because a
 * model that has just decided the elegant solution is in another language will
 * take a hint as permission. When nothing is known it says so and asks the
 * model to follow the source, which is better than naming a default that would
 * silently become the house language for every unreadable screenshot.
 */
export function answerLanguageRule(lang: AnswerLanguage): string {
  if (lang.source === "setting") {
    return (
      `Write the solution in ${lang.display}. This is a configured requirement, not a ` +
      `preference: if the problem is shown in another language, port it to ${lang.display} ` +
      `and say in one line that you did.`
    );
  }
  if (lang.source === "detected") {
    return (
      `Write the solution in ${lang.display}, the language the problem is in. Answering in ` +
      `another language is answering a different question — the result has to be pastable ` +
      `where the screenshot came from. If ${lang.display} genuinely cannot express the fix, ` +
      `say why before offering anything else.`
    );
  }
  return (
    "Write the solution in whatever language the problem is written in. If that is not " +
    "clear from the source, say which you chose and why on its own line before the code."
  );
}
