/**
 * Pulling the labelled sections out of the judge's reply.
 *
 * The judge answers in a flat block of `LABEL: text` lines because that survives
 * a language model far better than JSON does — the same reason the agents' FINAL
 * block is line-oriented. Reading it back out is this file's whole job.
 *
 * Three of the sections get their own place in the panel: approach, efficiency
 * and style. Those are the three things a technical interview actually turns on,
 * and having them findable at a glance is the difference between a verdict you
 * read and one you scroll past.
 */

export interface Verdict {
  verdict: string;
  correct: string;
  why: string;
  approach: string;
  efficiency: string;
  style: string;
  best: string;
  /** Anything before the first label, which is usually the judge thinking aloud. */
  preamble: string;
}

const LABELS: [keyof Verdict, string[]][] = [
  ["verdict", ["VERDICT"]],
  ["correct", ["CORRECT"]],
  ["why", ["WHY"]],
  ["approach", ["APPROACH"]],
  ["efficiency", ["EFFICIENCY", "COMPLEXITY"]],
  ["style", ["STYLE", "CODE STYLE"]],
  ["best", ["BEST ANSWER", "BEST"]],
];

const EMPTY: Verdict = {
  verdict: "",
  correct: "",
  why: "",
  approach: "",
  efficiency: "",
  style: "",
  best: "",
  preamble: "",
};

/**
 * Reads the sections, tolerating the ways a model will drift from the format.
 *
 * Labels arrive bolded (`**APPROACH:**`), lower-cased, or with the colon on the
 * next line. A parser that insists on one exact spelling produces an empty panel
 * and no clue why, so this accepts the variants and keeps whatever it could not
 * place rather than discarding it.
 */
export function parseVerdict(text: string): Verdict {
  if (!text.trim()) return { ...EMPTY };

  const lines = text.split("\n");
  const out: Verdict = { ...EMPTY };

  let current: keyof Verdict | null = null;
  const buffer: Record<string, string[]> = {};
  const preamble: string[] = [];

  for (const raw of lines) {
    // Strip markdown emphasis and list markers before looking for a label, so
    // `**APPROACH:**` and `- APPROACH:` both land.
    const bare = raw.replace(/\*\*/g, "").replace(/^\s*[-*]\s+/, "");
    const m = /^\s*([A-Za-z][A-Za-z ]{2,20}?)\s*:\s*(.*)$/.exec(bare);

    let matched: keyof Verdict | null = null;
    if (m) {
      const label = m[1].trim().toUpperCase();
      for (const [key, names] of LABELS) {
        if (names.includes(label)) {
          matched = key;
          break;
        }
      }
    }

    if (matched) {
      current = matched;
      buffer[current] = buffer[current] ?? [];
      if (m![2].trim()) buffer[current].push(m![2].trim());
      continue;
    }

    if (current) buffer[current].push(raw);
    else if (raw.trim()) preamble.push(raw);
  }

  for (const [key] of LABELS) {
    out[key] = (buffer[key] ?? []).join("\n").trim();
  }
  out.preamble = preamble.join("\n").trim();

  // Nothing recognised at all: rather than showing an empty panel next to a
  // reply that plainly said something, treat the whole thing as the verdict.
  if (!LABELS.some(([k]) => out[k])) {
    out.verdict = text.trim();
    out.preamble = "";
  }

  return out;
}

/** The three interview sections, in the order they are worth reading. */
export function highlights(v: Verdict): { key: string; label: string; body: string }[] {
  return [
    { key: "approach", label: "Approach", body: v.approach },
    { key: "efficiency", label: "Efficiency", body: v.efficiency },
    { key: "style", label: "Code style", body: v.style },
  ].filter((h) => h.body.trim() !== "");
}
