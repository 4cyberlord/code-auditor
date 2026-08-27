import { answerLanguageRule, type AnswerLanguage } from "./answerLanguage.ts";

/**
 * The agent contract.
 *
 * All four agents get the raw image and do their own reading of it — no single
 * transcription step, because that would make one model's OCR a shared point of
 * failure for the whole panel.
 *
 * The FINAL block is deliberately line-oriented rather than JSON: models escape
 * long code blocks into JSON unreliably, and one bad backslash would cost us the
 * whole comparison.
 */

export type Mode = "auto" | "code" | "research";

const CONTRACT = `
When you are finished, output a FINAL block, exactly once, as the last thing in your reply:

<<<FINAL
KIND: code | research
LANGUAGE: <language, or "n/a">
ANSWER: <one or two sentences stating the answer itself, not a description of your process>
COMPLEXITY: <time/space complexity, or "n/a">
CONFIDENCE: <0.00-1.00>
CLAIMS:
- <an atomic, checkable statement your answer depends on>
- <another; give 2 to 6 in total>
CODE:
\`\`\`<language>
<the complete runnable solution, or leave this fence empty for non-code answers>
\`\`\`
FINAL>>>

Rules for the FINAL block: no commentary inside it, ANSWER on a single line, and CODE must
be the whole solution rather than a fragment or a diff.`.trim();

const SHARED_ROLE = `
You are one of four independent expert agents working the same problem in parallel.
You cannot see the others and must not speculate about them. Your output is compared
against theirs afterwards, so being independently correct matters far more than being
agreeable or fast.

Read any attached image carefully and transcribe the problem before solving it. Images
are often photographs of a screen or a page: expect glare, cropping, and ambiguous
characters. If a character is genuinely ambiguous (l/1/I, O/0, rn/m), state the reading
you chose and why. If part of the problem is cut off, say so explicitly rather than
inventing the missing part.`.trim();

const CODE_ROLE = `
This is a programming problem. Work it as a senior engineer would:

1. Restate the problem and identify the exact inputs, outputs, and constraints.
2. Note edge cases before you write code — empty input, single element, duplicates,
   overflow, off-by-one boundaries, and whatever else the problem invites.
3. Write a complete, runnable solution. Not pseudocode, not a sketch.
4. Trace your solution by hand against at least one example and any edge case that
   worries you. If the trace fails, fix the code and say what you changed.
5. State time and space complexity.

Runtime discipline: optimise for the fastest correct approach the constraints justify.
For LeetCode-style answers, aim for a practical runtime at or below 17ms when that is
realistic in the target language, but never claim a millisecond runtime unless it was
actually measured. If it was not measured, write "Runtime: not measured" and give the
complexity instead.

Zero-ms target discipline: the product goal is to find solutions that could display as
Runtime: 0ms and Memory: <= 10MB on a judge, but exact numbers are evidence, not wishes.
Never claim "Runtime: 0ms" or a memory number unless measured. Internally check whether
the algorithm family, largest constraints, auxiliary data structures, and language
runtime make that target plausible; if not, say why and still ship the fastest correct
solution.

If the image contains code that is already written, audit it: say plainly whether it is
correct, name every bug you find with the line it is on, then give the corrected version.`.trim();

const RESEARCH_ROLE = `
This is not a programming problem — it is a question that needs reasoning and,
where relevant, factual grounding.

1. Restate what is actually being asked, including anything ambiguous about it.
2. Work through it step by step, showing the reasoning rather than only the conclusion.
3. Separate what you are confident about from what you are inferring. Where a fact could
   have changed recently or you are unsure of it, say so rather than asserting it.
4. Give the direct answer plainly, then the support for it.

Never fabricate a citation, statistic, or source. "I am not certain, and here is why"
is a correct answer; an invented reference is not.`.trim();

const AUTO_ROLE = `
First decide what kind of problem this is.

If it is a programming problem (write code, fix code, explain code, algorithm design),
set KIND to "code" and:
${CODE_ROLE}

Otherwise set KIND to "research" and:
${RESEARCH_ROLE}`.trim();

export function systemPrompt(mode: Mode, language?: AnswerLanguage): string {
  const role = mode === "code" ? CODE_ROLE : mode === "research" ? RESEARCH_ROLE : AUTO_ROLE;
  // Placed after the role and before the contract, so it reads as part of what
  // the job *is* rather than as a formatting note appended to the output spec.
  const lang = language ? `\n\n${answerLanguageRule(language)}` : "";
  return `${SHARED_ROLE}\n\n${role}${lang}\n\n${CONTRACT}`;
}

/**
 * Builds what an agent is actually asked.
 *
 * `extracted` is the rendered output of the vision pass (section 9): a structured
 * reading of the screenshot, produced by two vision models and cross-checked.
 * Its whole purpose is to let a model with no vision at all take part in the
 * panel — but a transcription is not the picture, and an agent that forgets the
 * difference will confidently solve a problem that was never on screen. So when
 * it is present the agent is told plainly what it is holding, and told to say so
 * rather than guess when the text is not enough.
 */
/** One attached image, as the prompt needs to describe it. */
export interface ImageRef {
  /** Same string for every piece of one capture. */
  group?: string;
  tile?: { index: number; count: number; where: string };
}

/**
 * The list of what is attached, in the order it is attached.
 *
 * Without this a model receives seven pictures and no idea whether they are
 * seven separate problems, one problem photographed seven times, or one screen
 * cut into seven pieces. It will guess, and it guesses differently each run.
 *
 * Two relationships have to survive, and they are not the same. Separate
 * screenshots are *sequential* — a later one may continue or correct an earlier
 * one. Pieces of a single screenshot are *simultaneous* and overlap, and reading
 * them as separate screens is how a line of code gets counted twice.
 */
export function imageManifest(images: ImageRef[]): string {
  if (images.length < 1) return "";

  // Numbered by capture, not by image: "screenshot 2, right half" is something a
  // person can point at, and "image 4 of 7" is not.
  const order: string[] = [];
  const seen = new Map<string, number>();
  for (const img of images) {
    const key = img.group ?? `solo-${order.length}`;
    if (!seen.has(key)) seen.set(key, seen.size + 1);
    const n = seen.get(key)!;
    order.push(
      img.tile && img.tile.count > 1
        ? `Screenshot ${n} — ${img.tile.where} piece (${img.tile.index} of ${img.tile.count})`
        : `Screenshot ${n}`
    );
  }

  const captures = seen.size;
  const lines = order.map((label, i) => `  ${i + 1}. ${label}`).join("\n");

  const head =
    captures === 1
      ? images.length === 1
        ? "One screenshot is attached."
        : `One screenshot is attached, cut into ${images.length} overlapping pieces because it was too large to send whole.`
      : `${captures} screenshots are attached, in the order they were taken, as ${images.length} images.`;

  const notes: string[] = [head, "", lines, ""];

  if (captures > 1) {
    notes.push(
      "They are one problem, not several. Read all of them before answering: a later " +
        "screenshot may continue, complete or correct an earlier one, and the question " +
        "may only make sense once you have seen the last."
    );
  }
  if (images.length > captures) {
    notes.push(
      "Pieces of the same screenshot are simultaneous, not sequential, and they overlap " +
        "slightly — a line of text cut off at the edge of one piece continues in the " +
        "neighbouring one. Reassemble them before reading rather than treating each as " +
        "its own screen."
    );
  }

  return notes.join("\n");
}

/**
 * Which language to reach for, and what to aim at, when the question does not say.
 *
 * This is a *default*, not an override, and the distinction is the whole point.
 * When a screenshot shows a Python stub, the answer belongs in Python -- that is
 * the language the question was asked in, and `answerLanguageRule` already says
 * so. This applies only to the case the first rule leaves open: a problem stated
 * with no language attached, where somebody still has to choose one.
 *
 * The targets are aims, not claims. The contract already forbids asserting a
 * runtime or a memory figure that was not measured, and nothing here relaxes
 * that -- an unmeasured "Runtime: 0ms" is still a lie whether or not it was the
 * target.
 */
/** "20 MB", "512 KB" — a figure a person reads without doing arithmetic. */
export function formatMemory(kb: number): string {
  const value = Math.max(0, Math.round(kb));
  return value >= 1024 ? `${Number((value / 1024).toFixed(value % 1024 === 0 ? 0 : 1))} MB` : `${value} KB`;
}

export function solutionPolicy(languages: string[] = ["C++", "Python"], memoryKb = 20480): string {
  const list = languages.filter((l) => l.trim());
  if (!list.length) return "";
  const order =
    list.length > 1
      ? `${list.slice(0, -1).join(", ")} and then ${list[list.length - 1]}`
      : list[0];
  return [
    `If the problem does not itself fix the language, write the solution in ${order}, in that order of preference.`,
    `${list[0]} is preferred because the bar here is measured, not asserted: the targets are a runtime that rounds to 0ms and a peak resident set no larger than ${formatMemory(memoryKb)}.`,
    "If you choose a language other than the first, say in one line why the first was unsuitable.",
    "Do not state a runtime or a memory figure you did not measure — these are targets to design toward, not numbers to report.",
  ].join(" ");
}

export function userPrompt(
  note: string,
  hasImage: boolean,
  extracted = "",
  images: ImageRef[] = [],
  knowledge = "",
  house = ""
): string {
  const parts: string[] = [];
  const context = extracted.trim();

  if (context && hasImage) {
    parts.push(
      "The screenshot is attached, and below it is a structured reading of that " +
        "same screenshot produced by two vision models. Use both. Where the " +
        "reading and the image disagree, the image is the truth and the reading " +
        "is the mistake — say which one you followed."
    );
  } else if (context) {
    parts.push(
      "You are not being shown the screenshot. What follows is a structured " +
        "reading of it, transcribed by two vision models that were checked " +
        "against each other. Treat it as the only evidence you have: if it is " +
        "internally inconsistent, or if something you need to answer properly is " +
        "missing or marked uncertain, say so plainly instead of filling the gap " +
        "yourself. An answer to a problem that was not on screen is worse than " +
        "no answer."
    );
  } else if (hasImage) {
    const manifest = imageManifest(images);
    parts.push(
      manifest
        ? `The problem is in the attached images. Read them, then solve it.\n\n${manifest}`
        : "The problem is in the attached image. Read it, then solve it."
    );
  }

  if (context) {
    parts.push(`--- READING OF THE SCREENSHOT ---\n${context}\n--- END OF READING ---`);
  }

  if (knowledge.trim()) {
    parts.push(`--- LOCAL KNOWLEDGE / RAG ---\n${knowledge.trim()}\n--- END KNOWLEDGE ---`);
  }

  if (house.trim()) {
    parts.push(`--- HOUSE RULES ---\n${house.trim()}\n--- END HOUSE RULES ---`);
  }

  if (note.trim()) {
    parts.push(note.trim());
  }
  if (!parts.length) {
    parts.push("Solve the attached problem.");
  }
  return parts.join("\n\n");
}

/** Prompt for the optional adjudication pass. */
export function judgePrompt(entries: { name: string; final: string }[], question: string): string {
  return judgePromptWithKnowledge(entries, question, "");
}

export function judgePromptWithKnowledge(
  entries: { name: string; final: string }[],
  question: string,
  knowledge: string
): string {
  const blocks = entries
    .map((e) => `### Agent ${e.name}\n${e.final}`)
    .join("\n\n---\n\n");
  return `Four independent agents answered the same problem. Judge them.

Problem context: ${question || "(see the agents' restatements)"}

${knowledge.trim() ? `Local Knowledge/RAG guidance:\n${knowledge.trim()}\n\n---\n\n` : ""}

${blocks}

---

Do not average them and do not split the difference. Decide which answer is actually
correct, checking the logic yourself rather than counting votes — a 3-1 majority can be
the wrong three. Then report:

VERDICT: <one line: do they agree, and is the agreed answer right?>
CORRECT: <which agents got it right, by name>
WHY: <the specific reasoning or bug that separates right from wrong>
APPROACH: <the technique the winning answer actually uses, named plainly — "hash map
  for complements in one pass", "two pointers on a sorted array" — and one sentence on
  why that technique fits this problem>
EFFICIENCY: <time and space complexity of the winning answer, and *why* it is that.
  Name what dominates: "O(n) time — one pass, each lookup O(1) amortised; O(n) space —
  the map holds up to n entries". Also say whether Runtime: 0ms / Memory <=10MB is
  plausible or only unmeasured>
STYLE: <what an interviewer would say about it: naming, edge cases handled or missed,
  early returns, dead code, anything they would ask you to change>
BEST ANSWER: <the answer you would ship, in full — include corrected code if relevant>

Keep APPROACH, EFFICIENCY and STYLE to two or three sentences each. They are read at a
glance, and they are the three things an interview actually turns on.`;
}
