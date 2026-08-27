/**
 * The council pipeline.
 *
 * Everything in this module is pure: no Tauri, no zustand, no fetch. The
 * orchestrator lives in store.ts; this file is the data model, the prompts, the
 * parsers and the scoring, so the whole thing can be exercised by `node
 * tests/council.test.ts` without a shell.
 *
 * The shape of a council run:
 *
 *   round 1   — N solvers answer independently (the existing panel contract)
 *   spec      — one model writes a machine-runnable test harness per language
 *   verify 1  — every code candidate executed against that harness
 *   round 2   — every solver reviews every candidate, anonymised by letter
 *   round 3   — every solver revises, having seen the reviews
 *   verify 2  — the revised field executed
 *   judges    — M judges each re-solve and review everything, with an emphasis
 *   synthesis — one model assembles the final answer from evidence, not votes
 *
 * Two rules are load-bearing and show up in every prompt below:
 *
 * 1. Anonymity. Candidates are letters, never model names. A reviewer told
 *    "GPT wrote A and Kimi wrote B" is not reviewing code any more, it is
 *    reviewing reputations.
 *
 * 2. Evidence outranks consensus. A candidate every model loves and the
 *    harness rejects is rejected. The prompts say so, and the scorer in this
 *    file enforces it, because a rule that only exists in a prompt is a rule a
 *    model can talk its way around.
 */

import type { AgentFinal } from "./parse.ts";

// ------------------------------------------------------------------ candidates

/** Candidate names. Ten solvers is the design; the alphabet past J is spare. */
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export const letterFor = (i: number): string => LETTERS[i] ?? `?${i}`;

export interface Candidate {
  /** The anonymised handle every prompt and review uses. */
  letter: string;
  /** Which model produced it. Never disclosed to reviewers or judges. */
  model: string;
  /** The parsed FINAL block. Null when the run failed outright. */
  final: AgentFinal | null;
  /** The full streamed text — what a judge reads when the FINAL was malformed. */
  text: string;
  error: string | null;
  /** The revision, when round 3 produced one. */
  revised?: AgentFinal | null;
  revisedText?: string;
}

/** What the reviewers and judges are shown: letters and work, never names. */
export function candidateDocket(
  candidates: Candidate[],
  opts: { revised?: boolean } = {}
): string {
  const blocks: string[] = [];
  for (const c of candidates) {
    const f = opts.revised ? (c.revised ?? null) : c.final;
    const body = f ? f.raw : c.error ? `(failed: ${c.error})` : "(no FINAL block)";
    blocks.push(`### Candidate ${c.letter}${opts.revised ? " (revised)" : ""}\n${body}`);
  }
  return blocks.join("\n\n---\n\n");
}

// -------------------------------------------------------------------- reviews

/** One reviewer's verdict about one candidate, parsed from a REVIEWS block. */
export interface CandidateReview {
  /** The candidate being reviewed. */
  letter: string;
  /** Which model wrote the review. UI-only; reviewers stay anonymous to peers. */
  reviewer: string;
  correct: "yes" | "no" | "unsure";
  /** Free text, folded to one line at parse time. Empty means "none found". */
  problems: string;
  time: string;
  space: string;
  quality: string;
}

/** A whole set from one reviewer, plus its top-level calls. */
export interface ReviewSet {
  reviewer: string;
  best: string;
  worst: string;
  reviews: CandidateReview[];
  /** The raw block, for the dossier a judge reads. */
  raw: string;
  wellFormed: boolean;
}

const REVIEWS_BLOCK = /<<<REVIEWS\s*([\s\S]*?)\s*REVIEWS>>>/i;

export function parseReviewSet(text: string, reviewer: string): ReviewSet {
  const match = text.match(REVIEWS_BLOCK);
  if (!match) {
    return { reviewer, best: "", worst: "", reviews: [], raw: text.slice(-3000), wellFormed: false };
  }
  const body = match[1];
  const field = (name: string) => {
    const m = body.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "im"));
    return m ? m[1].trim() : "";
  };
  const reviews: CandidateReview[] = [];
  // Stanzas are headed by `CANDIDATE: X`; anything before the first is header.
  const lines = body.split("\n");
  let cur: Record<string, string> | null = null;
  let lastKey = "";
  const flush = () => {
    if (!cur || !cur.letter) return;
    const correctRaw = (cur.correct ?? "").toLowerCase();
    reviews.push({
      letter: cur.letter.replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 1),
      reviewer,
      correct: correctRaw.startsWith("y") ? "yes" : correctRaw.startsWith("n") ? "no" : "unsure",
      problems: (cur.problems ?? "").trim(),
      time: (cur.time ?? "").trim(),
      space: (cur.space ?? "").trim(),
      quality: (cur.quality ?? "").trim(),
    });
  };
  for (const line of lines) {
    const kv = line.match(/^\s*([A-Z]+)\s*:\s*(.*)$/);
    if (kv && ["CANDIDATE", "CORRECT", "PROBLEMS", "TIME", "SPACE", "QUALITY"].includes(kv[1])) {
      if (kv[1] === "CANDIDATE") {
        flush();
        cur = { letter: kv[2].trim() };
      } else if (cur) {
        cur[kv[1].toLowerCase()] = kv[2];
        lastKey = kv[1].toLowerCase();
      }
    } else if (cur && lastKey && line.trim() && !/^<<<|>>>$/.test(line.trim())) {
      // Continuation of the previous field (a PROBLEMS line that wrapped).
      cur[lastKey] = `${cur[lastKey] ?? ""} ${line.trim()}`;
    }
  }
  flush();
  return {
    reviewer,
    best: field("BEST").replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 1),
    worst: field("WORST").replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 1),
    reviews,
    raw: match[0].trim(),
    wellFormed: true,
  };
}

/** What one solver is told about its own candidate before revising. */
export function reviewsOf(sets: ReviewSet[], letter: string): CandidateReview[] {
  return sets.flatMap((s) => s.reviews.filter((r) => r.letter === letter));
}

// ------------------------------------------------------------------ execution

/**
 * One runnable harness for one language.
 *
 * The harness is one complete program with a `<<<SOLUTION>>>` marker line.
 * The runner replaces the marker with the candidate's own code, verbatim, so
 * the spec writer never re-types anyone's solution — a model copying code is
 * a transcription error waiting to happen, and the splice removes it.
 */
export interface TestSuite {
  language: string;
  harness: string;
}

export const SPLICE_MARKER = "<<<SOLUTION>>>";

const TESTS_BLOCK = /<<<TESTS\s*([\s\S]*?)\s*TESTS>>>/i;

export function parseTestSuites(text: string): TestSuite[] {
  const match = text.match(TESTS_BLOCK);
  if (!match) return [];
  const body = match[1];
  const suites: TestSuite[] = [];
  // Pairs of `HARNESS: <lang>` followed by the next fenced block.
  const re = /HARNESS\s*:\s*([a-zA-Z0-9+#._-]+)\s*\n+\s*```[a-zA-Z0-9+#._-]*\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const harness = m[2].trim();
    if (harness.includes(SPLICE_MARKER)) {
      suites.push({ language: normalizeCodeLanguage(m[1]), harness });
    }
  }
  return suites;
}

/**
 * Every alias that means the same runtime, collapsed to one canonical name.
 *
 * There are three places a language string has to line up — the suite the spec
 * model emits, the candidate's own fence label, and the runtime table that
 * decides how to compile it. They only ever agreed by luck, because each one
 * did its own ad-hoc lowercasing. This is the single vocabulary all three now
 * speak.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  node: "javascript",
  nodejs: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  py3: "python",
  python3: "python",
  rb: "ruby",
  rs: "rust",
  golang: "go",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  "c++": "cpp",
  cplusplus: "cpp",
  cc: "cpp",
  cxx: "cpp",
};

/**
 * Canonical language name for a fence label or suite tag.
 *
 * Models label a fence with the standard they wrote against — ```c++17,
 * ```c++20, ```c11, ```python3.11 — not with the bare language. The runtime
 * table is keyed by language, so every one of those came back "Unsupported
 * benchmark language" and the candidate was dropped without ever being run.
 * That hit C++ hardest, which is the language the Council is meant to prefer.
 * Strip the standard, then resolve the alias.
 */
export function normalizeCodeLanguage(raw: string): string {
  let lang = String(raw || "").trim().toLowerCase().replace(/^\./, "");
  if (!lang) return "";
  lang = lang.replace(/[\s_-]+/g, "");
  // ```c++17, ```cpp20, ```cxx2x  ->  cpp   (checked before bare C, so the
  // "++" is never mistaken for a C standard suffix)
  if (/^(?:c\+\+|cpp|cxx)(?:\d{2}|\dx|2x)?$/.test(lang)) return "cpp";
  // ```c99, ```c11, ```c17, ```c23  ->  c
  if (/^c(?:\d{2})?$/.test(lang) && lang !== "cc") return "c";
  // ```python3.11, ```python3  ->  python
  if (/^python3(?:\.\d+)*$/.test(lang)) return "python";
  // ```node20, ```es2022  ->  javascript
  if (/^node(?:js)?\d*$/.test(lang) || /^es\d{4}$/.test(lang)) return "javascript";
  return LANGUAGE_ALIASES[lang] ?? lang;
}

/** Language of a candidate, normalised to the runner's vocabulary. */
export function candidateLanguage(c: AgentFinal): string {
  return normalizeCodeLanguage(c.language || "");
}

/** Splices a candidate's code into the harness. Null when marker is absent. */
export function spliceSuite(suite: TestSuite, code: string): string | null {
  if (!suite.harness.includes(SPLICE_MARKER)) return null;
  return suite.harness.replace(SPLICE_MARKER, () => code.trim());
}

/** One candidate's execution record. */
export interface CandidateRun {
  letter: string;
  /** False when there was no harness in the candidate's language, or no code. */
  ran: boolean;
  ok: boolean;
  /** Counted from PASS / FAIL lines in stdout when the harness prints them. */
  passed: number;
  failed: number;
  durationMs: number;
  /** "no suite for rust", "empty code", "exit 1", … */
  note: string;
  /** What executed it — "node 22", "python3". From the Rust runner. */
  runtime: string;
  /** Optional remote benchmark evidence from a GitHub Codespace. */
  remote?: {
    ok: boolean;
    codespace: string;
    runtime: string;
    durationMs: number;
    remoteElapsedMs: number | null;
    peakMemoryKb: number | null;
    note: string;
  };
}

/**
 * Reads one program's stdout for the harness convention: one line per case,
 * `PASS name` or `FAIL name`. A crash mid-run shows up as a short count, which
 * is exactly what it is.
 */
export function countCases(stdout: string): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const line of stdout.split("\n")) {
    if (/^\s*PASS\b/.test(line)) passed += 1;
    else if (/^\s*FAIL\b/.test(line)) failed += 1;
  }
  return { passed, failed };
}

/**
 * The gate. Anything a run rejected cannot win, however many models loved it;
 * anything nobody could execute is "unverified", not "correct". This is the
 * piece the whole design exists to protect, so it is a function here rather
 * than a paragraph in a prompt.
 */
export function gateFor(run: CandidateRun | undefined): "pass" | "fail" | "untested" {
  if (!run || !run.ran) return "untested";
  if (run.failed > 0 || !run.ok) return "fail";
  if (run.passed === 0) return "untested"; // exit 0 with no PASS lines proves nothing
  return "pass";
}

// --------------------------------------------------------------------- judges

/** What a judge pays extra attention to. Every judge still reviews everything. */
export type Emphasis = "algorithms" | "correctness" | "performance" | "engineering" | "security";

export interface JudgeSeat {
  model: string;
  emphasis: Emphasis;
}

/**
 * One council solver/judge seat.
 *
 * `endpoint` is set only for models that fail the classifier's wrong-wire
 * test on chat-completions. "chat" is the default and the only value the
 * roster needs to name when the model is ordinary.
 */
export interface CouncilModelSpec {
  id: string;
  /** Defaults to "chat". Set "responses" for models on the Responses API. */
  endpoint?: "chat" | "responses";
}

export interface JudgeReport {
  model: string;
  emphasis: Emphasis;
  text: string;
  error: string | null;
}

/**
 * The default bench, from the user's model lineup. All ids are TokenRouter's
 * catalogue names, verified against /models on 2026-08-25.
 *
 * gpt-5.3-codex and gpt-5.6-sol speak the OpenAI Responses API on the router,
 * not chat-completions — the `endpoint` field on their roster entries carries
 * that fact into the dispatcher so a correct name no longer meets an
 * "unsupported endpoint" error.
 */
export const COUNCIL_DEFAULT_MODELS: CouncilModelSpec[] = [
  // gpt-5.3-codex is a heavy seat: an agentic coding pass costs up to minutes
  // of thinking per round, and the council asks it to do that four times over
  // (solve, review, revise, plus every judge's re-read). Sitting it out of the
  // default bench until the user opts it back in is cheaper than finding out
  // at minute thirty-nine.
  { id: "anthropic/claude-sonnet-4.6", endpoint: "chat" },
  { id: "anthropic/claude-opus-4.6", endpoint: "chat" },
  { id: "moonshotai/kimi-k2.7-code", endpoint: "chat" },
  { id: "moonshotai/kimi-k3", endpoint: "chat" },
  { id: "x-ai/grok-4.6", endpoint: "chat" },
  { id: "google/gemini-3.7-flash", endpoint: "chat" },
  { id: "openai/gpt-5.6-sol", endpoint: "responses" },
  { id: "stealth/ox-alpha", endpoint: "chat" },
];

export const COUNCIL_DEFAULT_JUDGES: JudgeSeat[] = [
  { model: "anthropic/claude-opus-4.6", emphasis: "security" },
  { model: "anthropic/claude-sonnet-4.6", emphasis: "engineering" },
  { model: "openai/gpt-5.6-sol", emphasis: "performance" },
  { model: "google/gemini-3.7-flash", emphasis: "correctness" },
  { model: "x-ai/grok-4.6", emphasis: "algorithms" },
  // Fable shares the engineering lens with Sonnet on purpose: two judges
  // reading for maintainability is the bench's deliberate redundancy, not a
  // misassigned seat — it was the engineering judge in the original bench
  // design before the roster was rebuilt.
  { model: "anthropic/claude-fable-5", emphasis: "engineering" },
  // Kimi is the bench's second correctness pass: same lens as Gemini, and the
  // duplication is the point — two judges that disagree on correctness is the
  // signal the synthesizer reads.
  { model: "moonshotai/kimi-k3", emphasis: "correctness" },
];

export const COUNCIL_SIZE = { solversMin: 2, solversMax: 10, judgesMin: 1, judgesMax: 7 } as const;

// ------------------------------------------------------------------- progress

export type CouncilPhase =
  | "idle"
  | "solving"
  | "speccing"
  | "verifying"
  | "reviewing"
  | "revising"
  | "reverifying"
  | "judging"
  | "synthesizing"
  | "done"
  | "error"
  | "cancelled";

/** The run's whole record: what happened, what was measured, what won. */
export interface CouncilReport {
  candidates: Candidate[];
  suites: TestSuite[];
  /** Round-1 executions, then round-3 executions, keyed by letter. */
  runs: Record<string, CandidateRun>;
  revisedRuns: Record<string, CandidateRun>;
  reviews: ReviewSet[];
  judges: JudgeReport[];
  synthesis: string;
  /** The winning candidate's letter, when the synthesis names one. */
  winner: string;
}

// --------------------------------------------------------------------- prompts

const REVIEW_CONTRACT = `
Output one REVIEWS block, exactly once, as the last thing in your reply:

<<<REVIEWS
BEST: <the letter of the strongest candidate>
WORST: <the letter of the weakest>
CANDIDATE: A
CORRECT: yes | no | unsure
PROBLEMS: <the specific defects, or "none">
TIME: O(...)
SPACE: O(...)
QUALITY: <one line on naming, structure, idioms, risks>
END
CANDIDATE: B
... (one stanza per candidate)
REVIEWS>>>

Rules: review every candidate including your own, grade your own as harshly as
any other, and keep each field to one line. If execution results are supplied,
they override your intuition: a candidate that failed its tests is not correct,
whatever its prose claims. Do not invent Runtime: 0ms or memory numbers; mark
them as measured only when the execution or judge data proves them.`.trim();

export function reviewSystemPrompt(): string {
  return [
    "You are a senior engineer on a review council. Several solutions to the same problem,",
    "written independently, are labelled with letters. You do not know which model wrote",
    "which — grade the work, not a reputation.",
    "",
    "For each candidate decide for yourself whether it is correct: re-derive the answer,",
    "trace the code against the edge cases it invites (empty input, one element, duplicates,",
    "overflow, off-by-one), and name every defect you actually find. Do not average the",
    "candidates and do not assume the majority is right.",
    "Also check the performance budget: prefer the lowest-correct complexity, call out",
    "avoidable memory over 10MB, and say when Runtime: 0ms is only an unmeasured target.",
    "",
    REVIEW_CONTRACT,
  ].join("\n");
}

export function reviewUserPrompt(args: {
  question: string;
  docket: string;
  execution: string;
  knowledge?: string;
}): string {
  const parts = [
    "The problem:\n" + (args.question || "(see the candidates' restatements)"),
    args.knowledge?.trim() ? "Local Knowledge/RAG guidance:\n" + args.knowledge.trim() : "",
    "The candidates:\n\n" + args.docket,
  ].filter(Boolean);
  if (args.execution) {
    parts.push("Measured execution results (authoritative):\n" + args.execution);
  }
  parts.push("Review all of them now.");
  return parts.join("\n\n---\n\n");
}

export function reviseSystemPrompt(): string {
  return [
    "You are a senior engineer revising your own solution after council review.",
    "You will see the problem, the full candidate field (letters, anonymised), every",
    "review your candidate received, and any measured execution results.",
    "",
    "Produce your improved solution. Adopt a rival's approach when the evidence says",
    "it beats yours — an O(n) hash map beats your O(n log n) sort even if yours was",
    "prettier. Ignore praise and address every named defect. Confidence that survives",
    "review is earned, not kept.",
    "Optimise toward a judge-rounded Runtime: 0ms and Memory <=10MB when realistic,",
    "but do not claim those exact numbers unless measured evidence is supplied.",
    "",
    "End with the same FINAL block contract as before (KIND / LANGUAGE / ANSWER /",
    "COMPLEXITY / CONFIDENCE / CLAIMS / CODE), exactly once, as the last thing.",
  ].join("\n");
}

export function reviseUserPrompt(args: {
  question: string;
  letter: string;
  ownRaw: string;
  docket: string;
  received: string;
  execution: string;
}): string {
  const parts = [
    "The problem:\n" + (args.question || "(see the candidates' restatements)"),
    `Your earlier answer was Candidate ${args.letter}:\n${args.ownRaw}`,
    "The full field:\n\n" + args.docket,
    "What the council said about yours:\n" + (args.received || "(no stanza addressed to you)"),
  ];
  if (args.execution) {
    parts.push("Measured execution results (authoritative):\n" + args.execution);
  }
  parts.push("Revise.");
  return parts.join("\n\n---\n\n");
}

const EMPHASIS_BRIEF: Record<Emphasis, string> = {
  algorithms:
    "Pay extra attention to the algorithm each candidate actually uses: name it, give its real complexity, and single out any candidate whose stated complexity does not match its code.",
  correctness:
    "Pay extra attention to correctness: trace edge cases yourself — empty input, one element, duplicates, overflow, boundaries — and list every case each candidate gets wrong.",
  performance:
    "Pay extra attention to measured performance: constant factors, allocations, and whether the measured runs agree with the claimed complexity.",
  engineering:
    "Pay extra attention to engineering quality: naming, structure, error handling, dead code, and whether the code is something a team could maintain.",
  security:
    "Pay extra attention to security and systems behaviour: injection, resource exhaustion, unsafe input handling, and anything that would be a liability in production.",
};

export function judgeSystemPrompt(emphasis: Emphasis): string {
  return [
    "You are one judge on an engineering council's bench. You review the entire problem and",
    "the entire candidate field yourself — you are not a specialist who only reads one axis.",
    EMPHASIS_BRIEF[emphasis],
    "",
    "You receive: the problem, every original and revised candidate (letters, anonymised),",
    "the council's reviews, and measured execution results. Execution evidence overrides",
    "every opinion including yours: a candidate whose tests failed is wrong, full stop.",
    "Among correct candidates, prefer the one with the strongest complexity and smallest",
    "auxiliary memory. Treat Runtime: 0ms / Memory <=10MB as measured claims only.",
    "",
    "Report:\nVERDICT: <one line>\nRANKING: <letters, best first>\nCORRECT: <letters you",
    "verified correct yourself>\nWHY: <what separates the winner>\nDEFECTS: <per letter, the",
    "failures you found>\nBEST ANSWER: <the answer you would ship, in full - corrected code",
    "if relevant>",
  ].join("\n");
}

export function judgeUserPrompt(args: {
  question: string;
  docket: string;
  reviews: string;
  execution: string;
  knowledge?: string;
}): string {
  return [
    "The problem:\n" + (args.question || "(see the candidates' restatements)"),
    args.knowledge?.trim() ? "Local Knowledge/RAG guidance:\n" + args.knowledge.trim() : "",
    "The candidates (originals and revisions):\n\n" + args.docket,
    "The council's reviews:\n\n" + (args.reviews || "(no reviews were collected)"),
    args.execution
      ? "Measured execution results (authoritative):\n" + args.execution
      : "No execution results are available; say so where that leaves uncertainty.",
  ].filter(Boolean).join("\n\n---\n\n");
}

export function synthesisSystemPrompt(): string {
  return [
    "You are the final synthesizer of an engineering council. You do not take a vote;",
    "you assemble the strongest verified solution from evidence.",
    "",
    "Hard rules:",
    "- AI consensus never overrides objective failure. A candidate that failed its test",
    "  run is rejected even if every solver, reviewer, and judge preferred it.",
    "- Among survivors, prefer the strongest verified algorithm, then measured performance,",
    "  then code quality. When two are equal on evidence, the judges' reasoning breaks",
    "  the tie — quote it.",
    "- Do not invent benchmark milliseconds. If no execution result measured runtime,",
    "  say Runtime: not measured. For coding-interview problems, prefer approaches likely",
    "  to fit a <=17ms target when the constraints and language make that plausible.",
    "  The aspirational product target is judge-rounded Runtime: 0ms and Memory <=10MB;",
    "  exact numbers must come from measurement, otherwise report plausibility.",
    "- If nothing passed execution, say so and ship the best-unverified candidate",
    "  clearly labelled as such, with the defect list attached.",
    "",
    "Report, in this order:\nVERDICT: <one line>\nWINNER: <letter of the candidate you ship,",
    "or NONE>\nREJECTED: <letters and the one-line reason each>\nEVIDENCE: <tests passed,",
    "runtime, memory where measured>\nAPPROACH: <the technique, named plainly>\nFINAL ANSWER:",
    "<the complete corrected implementation or answer — assemble the best parts, do not",
    "just quote one candidate when a fix is trivial>",
  ].join("\n");
}

export function synthesisUserPrompt(args: {
  question: string;
  docket: string;
  reviews: string;
  execution: string;
  judges: string;
  knowledge?: string;
}): string {
  return [
    "The problem:\n" + (args.question || "(see the candidates' restatements)"),
    args.knowledge?.trim() ? "Local Knowledge/RAG guidance:\n" + args.knowledge.trim() : "",
    "The candidates (originals and revisions):\n\n" + args.docket,
    "The council's reviews:\n\n" + (args.reviews || "(none)"),
    args.execution
      ? "Measured execution results (authoritative):\n" + args.execution
      : "No execution results are available.",
    "The judges' reports:\n\n" + (args.judges || "(none)"),
  ].filter(Boolean).join("\n\n---\n\n");
}

// -------------------------------------------------------------- follow-ups

export function councilFollowupSystemPrompt(): string {
  return [
    "You are continuing after an engineering council has finished an audit.",
    "Answer the user's follow-up from the council record, not from memory.",
    "Be direct and practical. If the user asks for code, give corrected code.",
    "If the evidence is insufficient, say exactly what is missing.",
  ].join("\n");
}

export function councilFollowupUserPrompt(args: {
  question: string;
  report: string;
  history: string;
  message: string;
}): string {
  return [
    "Original problem:\n" + (args.question || "(not recorded)"),
    "Council record:\n" + args.report,
    args.history ? "Recent follow-up thread:\n" + args.history : "",
    "User follow-up:\n" + args.message,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

// -------------------------------------------------------------- the spec pass

export function testSpecSystemPrompt(): string {
  return [
    "You write test harnesses for candidate solutions. You will be shown a problem and a",
    "field of anonymised candidates. Write ONE harness per language that appears among the",
    "candidates.",
    "",
    "A harness is a complete program with three parts:",
    "1. A line containing exactly <<<SOLUTION>>> where the candidate's code will be spliced",
    "   in, verbatim. Wrap or rename whatever the candidates disagree on (function names,",
    "   signatures) so any of them drops in cleanly.",
    "2. A thorough test battery: the normal cases from the problem statement, then edge",
    "   cases (empty, one element, duplicates, zeros, negatives, maximum values), then at",
    "   least two adversarial cases designed to break a plausible-but-wrong approach.",
    "   Include at least one performance-shaped case when constraints are available, so",
    "   quadratic/brute-force candidates are exposed by size or structure.",
    "3. One output line per case: `PASS <name>` on success, `FAIL <name> got=<x> want=<y>` on",
    "   failure, and a non-zero process exit if anything failed.",
    "",
    "Output one block, exactly once:\n\n<<<TESTS\nHARNESS: <language>\n```<language>",
    "<complete program with the <<<SOLUTION>>> marker>\n```\nHARNESS: <next language>\n```...```",
    "\nTESTS>>>",
    "",
    "Write no commentary. If no candidate is code, output the block empty.",
  ].join("\n");
}

export function testSpecUserPrompt(args: {
  question: string;
  docket: string;
  languages: string[];
  knowledge?: string;
}): string {
  return [
    "The problem:\n" + (args.question || "(see the candidates' restatements)"),
    args.knowledge?.trim() ? "Local Knowledge/RAG guidance:\n" + args.knowledge.trim() : "",
    "The candidates:\n\n" + args.docket,
    `Languages to cover: ${args.languages.join(", ") || "none"}`,
  ].filter(Boolean).join("\n\n---\n\n");
}

// ------------------------------------------------------------- result digests

/** One line per candidate, fed verbatim into review/judge/synthesis prompts. */
export function executionDigest(
  candidates: Candidate[],
  runs: Record<string, CandidateRun>,
  opts: { revised?: boolean } = {}
): string {
  const lines: string[] = [];
  for (const c of candidates) {
    const run = runs[c.letter];
    const gate = gateFor(run);
    const tag = opts.revised && c.revised ? " (revised)" : "";
    if (!run || !run.ran) {
      lines.push(`Candidate ${c.letter}${tag}: not executed — ${run?.note || "no code"}`);
    } else {
      lines.push(
        `Candidate ${c.letter}${tag}: ${run.failed === 0 && run.ok ? "ALL PASSED" : "FAILED"} — ` +
          `${run.passed} passed, ${run.failed} failed, ${run.runtime}, ${run.durationMs}ms` +
          (run.remote
            ? `; Codespaces ${run.remote.ok ? "OK" : "FAILED"} on ${run.remote.codespace}, ` +
              `${run.remote.runtime}, ` +
              `${run.remote.remoteElapsedMs ?? run.remote.durationMs}ms` +
              (run.remote.peakMemoryKb != null ? `, peak ${Math.round(run.remote.peakMemoryKb / 1024)}MB` : "") +
              (run.remote.note ? ` (${run.remote.note})` : "")
            : "") +
          (gate === "fail" ? " [GATE: rejected]" : "")
      );
    }
  }
  return lines.join("\n");
}

/** The complete report, as it is written to history and shown in the panel. */
export function councilMarkdown(r: CouncilReport): string {
  const out: string[] = ["# Council report", ""];
  out.push(`Solvers: ${r.candidates.length} · reviews: ${r.reviews.length} · judges: ${r.judges.length}`);
  if (r.winner) out.push(`Winner: **${r.winner}**`);
  out.push("");
  const gateLines = r.candidates.map((c) => {
    const g1 = gateFor(r.runs[c.letter]);
    const g2 = c.revised ? gateFor(r.revisedRuns[c.letter]) : null;
    return `- ${c.letter} (${c.model}): round 1 ${g1}${g2 ? `, revised ${g2}` : ""}`;
  });
  if (gateLines.length) out.push("## Gates", ...gateLines, "");
  if (r.judges.length) {
    out.push("## Judges");
    for (const j of r.judges) out.push(`- ${j.model} (${j.emphasis})`);
    out.push("");
  }
  out.push("## Synthesis", "", r.synthesis);
  return out.join("\n");
}
