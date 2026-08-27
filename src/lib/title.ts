/**
 * Every session gets a name the moment there is anything to name it after.
 *
 * "Untitled session" repeated down a sidebar is a list you cannot navigate: the
 * thing you are looking for is identified only by its position, and position
 * changes every time you start something new. A name taken from the problem
 * itself — "Two sum with a hash map", "NameError in views.py" — is the
 * difference between scanning and remembering.
 *
 * It is a *suggestion*, always. The name is written to the same column the
 * rename box writes to, so changing it is not a special case and a renamed
 * session is never re-titled behind the user's back.
 */

import type { Extraction } from "./extraction.ts";

/** How long a name can get before it stops being scannable in a sidebar. */
const MAX = 52;

/**
 * Openers that describe the *asking* rather than the problem.
 *
 * A model told to summarise a screenshot very often starts with the fact that
 * it is a screenshot, and "The problem is to reverse a linked list" wastes the
 * first four words of a fifty-character name on nothing.
 */
const PREAMBLE = [
  /^the (?:problem|question|task|screenshot|image|user|code) (?:is|shows|asks|wants|contains)[:,]?\s*/i,
  /^this (?:is|screenshot|image|problem|question|code)\s*(?:is|shows|asks)?[:,]?\s*/i,
  /^(?:we|you) (?:are|need to|must|should|have to)\s*(?:be)?\s*(?:asked to)?\s*/i,
  /^(?:please\s+)?(?:write|implement|create|find|solve|fix|debug)\s+(?:a|an|the)\s+/i,
  /^(?:it|they) (?:is|are) asking (?:us |you )?to\s*/i,
  /^(?:given|consider)\s+(?:a|an|the)\s+/i,
];

/** Cuts a sentence down to a name without cutting a word in half. */
function shorten(text: string, max = MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  // A single very long word: better truncated than dropped entirely.
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : flat.slice(0, max)).trim();
}

/** First sentence or clause — a name is not a paragraph. */
function firstClause(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // Sentence end, then a clause boundary, in that order of preference.
  const sentence = flat.match(/^[^.!?]+[.!?]/);
  const head = (sentence ? sentence[0] : flat).replace(/[.!?]+$/, "");
  const clause = head.split(/[;:]|\s+—\s+|\s+-\s+/)[0];
  return clause.trim();
}

function tidy(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  let trimmedPreamble = false;
  for (const p of PREAMBLE) {
    const next = out.replace(p, "");
    if (next !== out) trimmedPreamble = true;
    out = next;
  }
  // "The problem is to reverse a linked list" leaves a dangling infinitive once
  // the opener is gone. Only stripped when an opener actually matched, so a
  // genuine "To-do list parser" keeps its first word.
  if (trimmedPreamble) out = out.replace(/^to\s+/i, "");
  out = firstClause(out);
  out = out.replace(/^[,\s]+/, "").replace(/[,\s]+$/, "");
  if (!out) return "";
  // Sentence case, but only the first letter: lowercasing the rest would turn
  // `NameError` into `nameerror` and `SQL` into `sql`.
  return shorten(out.charAt(0).toUpperCase() + out.slice(1));
}

/** The first named thing in a piece of code — usually what it is *for*. */
function symbolFrom(code: string): string {
  const patterns = [
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/m,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/m,
    /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|struct|enum)\s+([A-Za-z_]\w*)/m,
    /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/m,
    /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/m,
  ];
  for (const p of patterns) {
    const m = p.exec(code);
    if (m?.[1] && m[1].length > 1) return m[1];
  }
  return "";
}

/** `two_sum` / `twoSum` / `TwoSum` → "Two sum". */
function humanise(symbol: string): string {
  const words = symbol
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The first sentence of a paragraph, without the trailing punctuation. */
function firstSentence(text: string): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  const stop = /[.!?](\s|$)/.exec(trimmed);
  const sentence = stop ? trimmed.slice(0, stop.index) : trimmed;
  return sentence.split(/\r?\n/)[0]?.trim() ?? "";
}

export interface TitleSource {
  /** What the reading decided the problem was. The best source by far. */
  extraction?: Partial<Extraction> | null;
  /** Anything the person typed. Trusted above a model's summary. */
  note?: string;
  /**
   * What the panel answered, when nothing read the picture.
   *
   * The cloud path stopped transcribing by default — the models that can see
   * solve straight from the image — which removed the `problemSummary` this used
   * to name a run after. The answers are the next best thing and arrive for
   * free: a run called "Binary search on the partition of the smaller array" is
   * a run you can find again, and "Batch — lc4" is not.
   */
  answers?: { answer?: string; language?: string; code?: string }[];
}

/**
 * A name for this piece of work.
 *
 * Order of preference is order of authority. What the person typed beats what a
 * model inferred; what a model summarised beats what can be guessed from an
 * error; a symbol out of the code beats nothing. Returning "" is a legitimate
 * outcome — it means there is genuinely nothing to name this after yet, and the
 * caller should keep whatever placeholder it has rather than inventing one.
 */
export function titleFor({ extraction, note, answers }: TitleSource): string {
  const typed = tidy(note ?? "");
  if (typed.length >= 8) return typed;

  const e = extraction ?? {};

  const summarised = tidy(e.problemSummary ?? "");
  if (summarised.length >= 8) return summarised;

  // Nothing read the screenshot, so name it after what the panel concluded.
  // First sentence only: an answer is a paragraph and a title is a label.
  for (const candidate of answers ?? []) {
    const first = firstSentence(candidate.answer ?? "");
    const named = tidy(first);
    if (named.length >= 8) return shorten(named);
  }

  // An error on screen is what the session is about, even with no summary.
  const firstError = e.errors?.[0]?.message ?? "";
  if (firstError.trim()) {
    const where = e.fileName || e.filePath?.split("/").pop() || "";
    const message = tidy(firstError);
    if (message) return shorten(where ? `${message} in ${where}` : message);
  }

  const symbol = humanise(symbolFrom(e.code ?? ""));
  if (symbol) {
    const lang = (e.language ?? "").trim();
    return shorten(lang ? `${symbol} (${lang})` : symbol);
  }

  // A terminal session with no error is still identifiable by its command.
  const command = (e.terminalCommands ?? [])[0] ?? "";
  if (command.trim()) return shorten(tidy(command));

  if (typed) return typed;
  return "";
}

/**
 * The placeholder a session carries until there is something better.
 *
 * Deliberately not "Untitled": it says when, which is the only thing actually
 * known at that moment, and it is what makes two placeholders distinguishable
 * in the second before the reading lands.
 */
export function placeholderTitle(when: string): string {
  return when ? `Session — ${when}` : "New session";
}

/**
 * Whether a title is one the app invented and may therefore replace.
 *
 * A name the user typed is never overwritten. Without this check the auto-titler
 * would rename a session the moment a second screenshot arrived, which is the
 * kind of thing that makes people stop trusting an app with their data.
 */
export function isPlaceholder(title: string): boolean {
  const t = title.trim();
  return (
    !t ||
    t === "New session" ||
    t === "Untitled session" ||
    /^Session — /.test(t) ||
    // Names the batch runner and the smoke test invent before anyone knows what
    // the question is. They are scaffolding, not decisions, and leaving them in
    // place is how a history list fills up with "Batch — lc4".
    /^Batch — /.test(t) ||
    /^Cloud smoke\b/.test(t) ||
    /^Council batch\b/.test(t)
  );
}
