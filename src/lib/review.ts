/**
 * The read-out on a finished solution.
 *
 * The panel already says whether four models agreed. Agreement is not the
 * question a person actually has in front of a solution, which is: is this
 * right, what is it doing, could it be faster, and is it written well. Those
 * four answers were spread across four panes and a verdict string; this puts
 * them in one place, in a shape the UI can lay out rather than paragraphs it has
 * to render blind.
 *
 * The ports matter as much as the review. A question asked in Python gets
 * answered in Python -- that rule stays -- but the same algorithm in C++ and
 * Rust is often the interesting comparison, and reading three implementations
 * side by side is how you decide which one you actually want. The performance
 * targets are deliberately *not* enforced across the ports: they are offered for
 * comparison, and the choice of which to ship is the reader's.
 */

/** The languages every solution is offered in, in tab order. */
export const PORT_LANGUAGES = ["cpp", "rust", "python"] as const;
export type PortLanguage = (typeof PORT_LANGUAGES)[number];

export const PORT_LABELS: Record<PortLanguage, string> = {
  cpp: "C++",
  rust: "Rust",
  python: "Python",
};

export type Grade = "excellent" | "good" | "fair" | "poor" | "";

export interface SolutionReview {
  /** Whether the reviewer believes the solution actually solves the problem. */
  valid: boolean | null;
  /** One line saying why, in the reviewer's words. */
  validNote: string;

  approach: { current: string; suggested: string; keyIdea: string };
  efficiency: { currentTime: string; currentSpace: string; suggestedTime: string; suggestedSpace: string; note: string };
  style: { readability: Grade; structure: Grade; note: string };

  /** The same solution in each language, keyed by language. Missing is normal. */
  ports: Partial<Record<PortLanguage, string>>;
}

export const EMPTY_REVIEW: SolutionReview = {
  valid: null,
  validNote: "",
  approach: { current: "", suggested: "", keyIdea: "" },
  efficiency: { currentTime: "", currentSpace: "", suggestedTime: "", suggestedSpace: "", note: "" },
  style: { readability: "", structure: "", note: "" },
  ports: {},
};

export function reviewSystemPromptFor(): string {
  return [
    "You are reviewing one finished solution to a programming problem, for a reader who",
    "already has the code and wants to know four things: is it correct, what is it doing,",
    "could it be faster, and is it written well.",
    "",
    "Be specific and short. 'Perfectly optimized' is only worth writing when you can name the",
    "bound it reaches. If the solution is wrong, say so plainly in VALID and name the case it",
    "fails — a review that softens a wrong answer is worse than no review.",
    "",
    "Then write the same algorithm in C++, Rust and Python. Same approach in all three, each",
    "idiomatic for its language and complete enough to compile or run. Do not change the",
    "algorithm between them, and do not optimise one and not the others — they exist to be",
    "compared, so the only difference should be the language.",
    "",
    "Output exactly this block and nothing else:",
    "",
    "<<<REVIEW",
    "VALID: yes | no",
    "WHY: <one line>",
    "APPROACH: <the named technique, e.g. Two Pointers>",
    "APPROACH_SUGGESTED: <the technique you would use; repeat the same name if it is already right>",
    "KEY_IDEA: <one sentence on how it works>",
    "TIME: <current, e.g. O(n)>",
    "SPACE: <current, e.g. O(1)>",
    "TIME_SUGGESTED: <best achievable; repeat if already optimal>",
    "SPACE_SUGGESTED: <best achievable; repeat if already optimal>",
    "EFFICIENCY_NOTE: <one line>",
    "READABILITY: excellent | good | fair | poor",
    "STRUCTURE: excellent | good | fair | poor",
    "STYLE_NOTE: <one line>",
    "PORT cpp",
    "```cpp",
    "<complete C++ implementation>",
    "```",
    "PORT rust",
    "```rust",
    "<complete Rust implementation>",
    "```",
    "PORT python",
    "```python",
    "<complete Python implementation>",
    "```",
    "REVIEW>>>",
  ].join("\n");
}

export function reviewUserPromptFor(args: { question: string; language: string; code: string; answer: string }): string {
  return [
    args.question.trim() ? `The problem:\n${args.question.trim()}` : "",
    args.answer.trim() ? `What the solution claims to do:\n${args.answer.trim()}` : "",
    `The solution, in ${args.language || "an unstated language"}:\n\`\`\`\n${args.code.trim()}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const BLOCK = /<<<REVIEW\s*([\s\S]*?)\s*REVIEW>>>/i;

function field(body: string, name: string): string {
  const m = new RegExp(`^${name}\\s*:\\s*(.+)$`, "im").exec(body);
  return m ? m[1].trim() : "";
}

function grade(raw: string): Grade {
  const v = raw.trim().toLowerCase();
  return v === "excellent" || v === "good" || v === "fair" || v === "poor" ? v : "";
}

/**
 * Pull the three ports out.
 *
 * Matched by the `PORT <lang>` marker rather than by fence label, because models
 * are inconsistent about fence labels and consistent about following a marker
 * they were told to write. A missing port is normal — one model refusing Rust
 * should not cost you the other two.
 */
function ports(body: string): Partial<Record<PortLanguage, string>> {
  const out: Partial<Record<PortLanguage, string>> = {};
  for (const lang of PORT_LANGUAGES) {
    const re = new RegExp(`^PORT\\s+${lang}\\s*$\\s*\`\`\`[a-z0-9+#_-]*\\s*\\n([\\s\\S]*?)\`\`\``, "im");
    const m = re.exec(body);
    const code = m?.[1]?.trim();
    if (code) out[lang] = code;
  }
  return out;
}

/** Null when the reply carried no review block at all. */
export function parseReview(text: string): SolutionReview | null {
  const m = BLOCK.exec(text ?? "");
  if (!m) return null;
  const body = m[1];

  const validRaw = field(body, "VALID").toLowerCase();
  const valid = /^(yes|true|valid)\b/.test(validRaw)
    ? true
    : /^(no|false|invalid)\b/.test(validRaw)
      ? false
      : null;

  const time = field(body, "TIME");
  const space = field(body, "SPACE");

  return {
    valid,
    validNote: field(body, "WHY"),
    approach: {
      current: field(body, "APPROACH"),
      // A reviewer that names no alternative is saying the current one stands.
      suggested: field(body, "APPROACH_SUGGESTED") || field(body, "APPROACH"),
      keyIdea: field(body, "KEY_IDEA"),
    },
    efficiency: {
      currentTime: time,
      currentSpace: space,
      suggestedTime: field(body, "TIME_SUGGESTED") || time,
      suggestedSpace: field(body, "SPACE_SUGGESTED") || space,
      note: field(body, "EFFICIENCY_NOTE"),
    },
    style: {
      readability: grade(field(body, "READABILITY")),
      structure: grade(field(body, "STRUCTURE")),
      note: field(body, "STYLE_NOTE"),
    },
    ports: ports(body),
  };
}

/** Whether the reviewer thinks the current choice is already the right one. */
export function isAlreadyOptimal(review: SolutionReview): boolean {
  const e = review.efficiency;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return (
    same(review.approach.current, review.approach.suggested) &&
    same(e.currentTime, e.suggestedTime) &&
    same(e.currentSpace, e.suggestedSpace)
  );
}
