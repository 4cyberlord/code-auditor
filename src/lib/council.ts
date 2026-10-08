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
  /**
   * What the runner itself measured, when it measured anything.
   *
   * The sandbox runs the same metrics script the remote runners do, so these
   * exist for a local or E2B run too. Dropping them was why a second run on
   * GitHub Actions looked like the only way to get a number.
   */
  remoteElapsedMs?: number | null;
  peakMemoryKb?: number | null;
  /** Which runner produced the figures above: "local", "e2b", … */
  provider?: string;
  executionId?: string;
  sandboxId?: string | null;
  state?: "queued" | "running" | "completed" | "failed" | "canceled" | "timed_out";
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  bootMs?: number | null;
  network?: "denied" | "unknown" | "allowed";
  stderr?: string;
  stdout?: string;
  /** "no suite for rust", "empty code", "exit 1", … */
  note: string;
  /** What executed it — "node 22", "python3". From the Rust runner. */
  runtime: string;
  /** Optional second-pass benchmark evidence from a remote runner. */
  remote?: {
    ok: boolean;
    runner: string;
    /** Legacy report key kept readable for history rows written before runner. */
    codespace?: string;
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


/**
 * Phase 5: an evidence-first shortlist for synthesizers.
 * Only passing executions can be ranked when any code was executed.
 * Never convert majority opinion or model confidence into test evidence.
 */
export function selectVerifiedCandidate(runs: Record<string, CandidateRun>): {
  winner: string | null;
  eligible: string[];
  reason: string;
} {
  const all = Object.entries(runs);
  const passed = all.filter(([, run]) => gateFor(run) === "pass");
  if (!passed.length) {
    return {
      winner: null, eligible: [],
      reason: all.some(([, run]) => run?.ran)
        ? "No candidate passed executable tests; no winner is justified."
        : "No execution evidence is available; do not claim a verified winner.",
    };
  }
  passed.sort(([letterA, a], [letterB, b]) => {
    // More passing cases are stronger coverage evidence, not a popularity vote.
    if (a.passed !== b.passed) return b.passed - a.passed;
    // A reliable elapsed metric can break ties, but missing data cannot win.
    const elapsedA = a.remoteElapsedMs;
    const elapsedB = b.remoteElapsedMs;
    const validA = typeof elapsedA === "number" && Number.isFinite(elapsedA) && elapsedA >= 0;
    const validB = typeof elapsedB === "number" && Number.isFinite(elapsedB) && elapsedB >= 0;
    if (validA && validB && elapsedA !== elapsedB) return elapsedA - elapsedB;
    if (validA !== validB) return validA ? -1 : 1;
    return letterA.localeCompare(letterB);
  });
  return {
    winner: passed[0][0],
    eligible: passed.map(([letter]) => letter),
    reason: `Candidate ${passed[0][0]} has a passing execution (${passed[0][1].passed} tests). This is evidence-based selection, not proof beyond the tested cases.`,
  };
}

/**
 * Did the *test* fail, rather than the code?
 *
 * When two candidates written independently by different models run the same
 * generated harness and come back with the identical score -- the same number
 * passed, the same number failed -- the thing they have in common is not their
 * reasoning. It is the harness. Two strangers do not make the same mistake in
 * the same place; two strangers measured against a wrong expectation do.
 *
 * This happened on the first real run: two correct solutions to "median of two
 * sorted arrays" both scored 18/19 against a generated suite, and the Council
 * rejected both with confidence. The algorithms were right. One test case was
 * outside the problem's own constraints.
 *
 * Candidates that never got as far as running a test are excluded, because a
 * program that failed to start has no score to agree with anyone about.
 *
 * This does not reverse the gate -- a failure is still a failure, and nothing
 * here promotes a rejected candidate. It raises a doubt, in front of the judges,
 * where a human can see it.
 */
export function harnessIsSuspect(runs: Record<string, CandidateRun>): string {
  const scored = Object.values(runs).filter((r) => r?.ran && r.passed + r.failed > 0);
  if (scored.length < 2) return "";
  if (!scored.every((r) => r.failed > 0)) return "";
  const [first] = scored;
  const identical = scored.every((r) => r.passed === first.passed && r.failed === first.failed);
  if (!identical) return "";
  const letters = scored.map((r) => r.letter).join(", ");
  return (
    `Candidates ${letters} were written independently and scored identically ` +
    `(${first.passed} passed, ${first.failed} failed). Independent solutions do not ` +
    `usually fail in the same place, so treat the generated harness as the more ` +
    `likely fault and say which specific case it is before blaming the code.`
  );
}

/** What the gate did to a synthesis that named a winner. */
export interface GateRuling {
  /** The winner that survives. Empty string when the gate rejected it. */
  winner: string;
  /** Set only when the synthesis was overruled. */
  overruledReason: string;
}

/**
 * The gate, applied to the synthesis itself.
 *
 * `gateFor` already decides whether a candidate's run passed. Nothing enforced
 * that against the final answer, because the synthesis is prose and the rule
 * lived in a prompt -- and a prompt is a request, not a constraint. On the first
 * real run the synthesis took a candidate whose program never started, called
 * the failure environmental, declared its logic "provably correct per both
 * judges", and built the final answer on it. The gate was never overridden out
 * loud; the evidence was reinterpreted until it seemed not to apply.
 *
 * So the check moved here, into code the model does not get a say in. A winner
 * whose run did not pass is not a winner.
 *
 * One deliberate exception: when nothing was executed at all -- an MCQ, a maths
 * question, a research answer -- there is no objective result, and a gate with
 * no evidence behind it must not veto anything. Objective failure outranks
 * consensus. Objective *silence* does not.
 */
export function enforceWinnerGate(winner: string, runs: Record<string, CandidateRun>): GateRuling {
  const letter = (winner || "").trim().toUpperCase();
  if (!letter) return { winner: "", overruledReason: "" };
  const executed = Object.values(runs).some((r) => r?.ran);
  if (!executed) return { winner: letter, overruledReason: "" };

  const gate = gateFor(runs[letter]);
  if (gate === "pass") return { winner: letter, overruledReason: "" };

  const run = runs[letter];
  const detail =
    gate === "untested"
      ? `it was never executed (${run?.note || "no run"})`
      : `its run failed (${run?.passed ?? 0} passed, ${run?.failed ?? 0} failed${run?.note ? `, ${run.note}` : ""})`;
  return {
    winner: "",
    overruledReason:
      `The synthesis named Candidate ${letter} as the winner, but ${detail}. ` +
      `Execution outranks agreement, so no winner is recorded.`,
  };
}

/** What the run is entitled to claim about the answer it produced. */
export interface AnswerStanding {
  standing: "verified" | "unverified" | "unexecuted";
  /** One sentence, written to be stamped on the report where a reader sees it. */
  reason: string;
}

/**
 * Is the answer this run produced actually backed by anything?
 *
 * `enforceWinnerGate` guards the winner *field*. That turned out to be the wrong
 * thing to guard. A synthesis can write `WINNER: NONE` — satisfying the gate,
 * because an empty winner is nothing to overrule — and then ship a rejected
 * candidate's logic in its FINAL ANSWER anyway. That is not hypothetical; it is
 * what the first real run did, in these words:
 *
 *   WINNER: NONE (all gate-rejected), but shipping best-unverified candidate A's
 *   logic in Python …
 *
 * The rule was never broken. It was complied with and walked around. So the
 * question asked here is not "may this winner stand" but "is there any executed
 * evidence behind the thing a person is about to paste into an editor", and the
 * answer is stamped on the report rather than left for the reader to infer.
 *
 * Three outcomes, deliberately distinct. `unexecuted` is not a failure — an MCQ
 * or a research answer has nothing to run — and conflating it with `unverified`
 * would cry wolf on every non-coding question.
 */
export function answerStanding(winner: string, runs: Record<string, CandidateRun>): AnswerStanding {
  const executed = Object.values(runs).some((r) => r?.ran);
  if (!executed) {
    return {
      standing: "unexecuted",
      reason: "Nothing was executed for this question, so the answer rests on reasoning alone.",
    };
  }

  const letter = (winner || "").trim().toUpperCase();
  if (letter && gateFor(runs[letter]) === "pass") {
    const run = runs[letter];
    return {
      standing: "verified",
      reason: `Candidate ${letter} passed ${run.passed} generated test case(s) before being selected.`,
    };
  }

  const passed = Object.values(runs)
    .filter((r) => gateFor(r) === "pass")
    .map((r) => r.letter);
  return {
    standing: "unverified",
    reason: passed.length
      ? `No selected candidate carries a passing run. Candidate(s) ${passed.join(", ")} did pass, so prefer one of those over the text below.`
      : "Every candidate that ran failed its generated tests. Nothing here has been shown to work — treat the answer as a lead to check, not a solution to ship.",
  };
}

/**
 * Routes that refused the picture rather than the prompt.
 *
 * Vision belongs to the route, and a route can only be proven blind by being
 * shown something. Nothing was writing that proof down: only timeouts benched a
 * model, so a route that rejects image content was handed the same picture on
 * every job forever. Recognising the refusal is what closes that loop.
 */
export function rejectedImages(text: string): boolean {
  const t = (text || "").toLowerCase();

  // A route that says outright what it is needs no second signal.
  if (t.includes("text-only") || t.includes("text only") || t.includes("only accepts text")) return true;

  // Otherwise the complaint has to be about the picture *and* be a refusal —
  // "429" on a request that happened to carry an image says nothing about
  // whether the route can carry one.
  const mentionsImage =
    t.includes("image") || t.includes("image_url") || t.includes("vision") || t.includes("multimodal");
  if (!mentionsImage) return false;
  return (
    t.includes("unsupported") ||
    t.includes("not supported") ||
    t.includes("does not support") ||
    t.includes("cannot process") ||
    t.includes("invalid") ||
    t.includes("unrecognized") ||
    t.includes("unexpected")
  );
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
/** How hard a model is asked to think before it answers. */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

export interface CouncilModelSpec {
  id: string;
  /** Per-seat override for how hard this model thinks. Unset follows the setting. */
  reasoning?: ReasoningEffort;
  /** Defaults to "chat". Set "responses" for models on the Responses API. */
  endpoint?: "chat" | "responses";
  /**
   * Whether this route carries an image. Leave unset for "nobody has checked".
   * A measured probe always outranks whatever is written here.
   */
  vision?: boolean;
}

export interface JudgeReport {
  model: string;
  emphasis: Emphasis;
  text: string;
  error: string | null;
}

/** The default Council roster. All ids are TokenRouter catalogue names. */
export const COUNCIL_DEFAULT_MODELS: CouncilModelSpec[] = [
  { id: "moonshotai/kimi-k3", endpoint: "chat" },
  { id: "z-ai/glm-5.3", endpoint: "chat" },
  { id: "x-ai/grok-4.6", endpoint: "chat" },
  { id: "google/gemini-3.7-flash", endpoint: "chat" },
];

export const COUNCIL_DEFAULT_JUDGES: JudgeSeat[] = [
  { model: "openai/gpt-5.6-sol", emphasis: "performance" },
  { model: "anthropic/claude-opus-5", emphasis: "security" },
];

export const COUNCIL_SIZE = { solversMin: 2, solversMax: 10, judgesMin: 1, judgesMax: 7 } as const;

/**
 * Gateway models that speak `/responses` rather than `/chat/completions`.
 *
 * This list used to exist twice — once in the desktop store, once in the cloud
 * worker — with no mechanism keeping the two honest. They happened to agree
 * today; the next model added to one of them would have been sent down the
 * wrong wire by the other, and that failure looks like a model refusing rather
 * than a router misdialling. One copy, in the file both sides already import.
 */
export const RESPONSES_MODELS = new Set(["openai/gpt-5.3-codex", "openai/gpt-5.6-sol"]);

/**
 * Which wire a model answers on.
 *
 * The roster wins when it names an endpoint, because that is the user's own
 * statement about a seat they configured. `RESPONSES_MODELS` is only the
 * fallback for a model nobody has classified — a judge seat, for instance,
 * which carries an emphasis but no endpoint.
 */
export function endpointForCouncilModel(
  roster: CouncilModelSpec[] | undefined,
  model: string
): "chat" | "responses" {
  const id = (model || "").trim();
  if (!id) return "chat";
  const spec = (roster?.length ? roster : COUNCIL_DEFAULT_MODELS).find((m) => m.id === id);
  return spec?.endpoint ?? (RESPONSES_MODELS.has(id) ? "responses" : "chat");
}

/**
 * Routes already measured to refuse an image, so nobody has to learn it twice.
 *
 * Vision is a property of the *route*, not the model. Gemini is natively
 * multimodal everywhere else and still had its connection dropped the moment an
 * image part was attached through this gateway. TokenRouter's own catalogue
 * meanwhile lists every model here as "Text", including ones that read
 * screenshots perfectly — that column describes what a model emits, not what it
 * can be shown. So neither the vendor's word nor the gateway's is worth much.
 * Only measurement is, and this is where measurements are remembered.
 */
export const BLIND_GATEWAY_ROUTES = new Set(["google/gemini-3.7-flash"]);

/**
 * How hard this model should think before answering.
 *
 * On by default, and high, because of what this panel is for. A Council seat is
 * not being asked to chat — it is being asked to solve a problem that another
 * four models and five judges will then pick apart, against a harness that runs
 * its code. An answer that arrives quickly and fails the harness has cost more
 * than a slow one that passes: the fast wrong answer still spends a review pass,
 * a judge pass and a benchmark run before anyone finds out.
 *
 * A seat can override it, and the setting can turn it down globally — some
 * questions genuinely are lookups, and paying a reasoning budget for those is
 * waste in the other direction.
 */
export function reasoningForModel(
  settings: { reasoningEffort?: string; councilModels?: CouncilModelSpec[] } | undefined,
  model: string
): ReasoningEffort {
  const id = (model || "").trim();
  const roster = settings?.councilModels?.length ? settings.councilModels : COUNCIL_DEFAULT_MODELS;
  const seat = roster.find((m) => m.id === id)?.reasoning;
  if (seat) return seat;
  const configured = (settings?.reasoningEffort || "").trim().toLowerCase();
  if (configured === "off" || configured === "low" || configured === "medium" || configured === "high") {
    return configured;
  }
  return "high";
}

/**
 * The request fields that ask for reasoning on each wire.
 *
 * The two APIs spell it differently and neither tolerates the other's spelling,
 * so this is the one place that knows which is which. Returns nothing when
 * reasoning is off, so the caller can spread it unconditionally.
 */
export function reasoningFields(
  effort: ReasoningEffort,
  endpoint: "chat" | "responses"
): Record<string, unknown> {
  if (effort === "off") return {};
  return endpoint === "responses"
    ? { reasoning: { effort } }
    : { reasoning_effort: effort };
}

/**
 * Did the gateway reject the request *because* of the reasoning fields?
 *
 * Not every route accepts them, and a model that does not is not broken — it
 * simply has no reasoning mode. Recognising that specific complaint is what
 * lets the caller drop the fields and ask again, instead of recording a dead
 * seat for a parameter the seat never needed.
 */
export function rejectedReasoning(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t.includes("reasoning")) return false;
  return (
    t.includes("unsupported") ||
    t.includes("unrecognized") ||
    t.includes("unknown") ||
    t.includes("not supported") ||
    t.includes("does not support") ||
    t.includes("invalid") ||
    t.includes("extra fields") ||
    t.includes("unexpected")
  );
}

/**
 * Can this model be shown the picture?
 *
 * In order of authority: a probe that actually sent an image down this exact
 * route and saw what came back; then the roster, which is the user's own
 * statement about a seat they configured; then the known-blind list. A model
 * nobody has classified is assumed to see, because the alternative is that a
 * newly added model silently never participates and nobody can tell why.
 */
export function canModelSee(
  probes: Record<string, { vision?: boolean | null } | undefined> | undefined,
  roster: CouncilModelSpec[] | undefined,
  model: string
): boolean {
  const id = (model || "").trim();
  if (!id) return false;
  const measured = probes?.[id]?.vision;
  if (typeof measured === "boolean") return measured;
  const spec = (roster?.length ? roster : COUNCIL_DEFAULT_MODELS).find((m) => m.id === id);
  if (typeof spec?.vision === "boolean") return spec.vision;
  return !BLIND_GATEWAY_ROUTES.has(id);
}

/** Who gets shown the screenshot, and who sits the round out. */
export function partitionByVision<T>(
  items: T[],
  idOf: (item: T) => string,
  probes: Record<string, { vision?: boolean | null } | undefined> | undefined,
  roster: CouncilModelSpec[] | undefined
): { seeing: T[]; resting: T[] } {
  const seeing: T[] = [];
  const resting: T[] = [];
  for (const item of items) {
    (canModelSee(probes, roster, idOf(item)) ? seeing : resting).push(item);
  }
  return { seeing, resting };
}

/**
 * Is this a coding problem?
 *
 * Asked of the answers rather than of the picture, because the answers are the
 * first place in the pipeline where anybody has actually understood the
 * question. A panel that comes back with code has told you what kind of problem
 * it was more reliably than any classifier run over the pixels beforehand.
 */
export function looksLikeCodingProblem(candidates: { final?: AgentFinal | null }[]): boolean {
  return candidates.some((c) => c.final?.kind === "code" && Boolean(c.final.code?.trim()));
}

/**
 * Seats the key can actually reach, and the ones it cannot.
 *
 * The router's catalogue answers "is this key entitled to that model" for every
 * model at once, in one request. Checking a roster against it costs nothing and
 * happens before any work starts, so a judge seat holding an id this key has no
 * access to is discovered here rather than forty minutes into a run as a 403.
 *
 * An empty catalogue means nobody has asked yet, which is not the same as
 * nothing being available — so it disqualifies nothing.
 */
export function reachableSeats<T>(
  seats: T[],
  idOf: (seat: T) => string,
  catalogue: string[] | undefined
): { reachable: T[]; unreachable: T[] } {
  if (!catalogue?.length) return { reachable: seats, unreachable: [] };
  const known = new Set(catalogue);
  const reachable: T[] = [];
  const unreachable: T[] = [];
  for (const seat of seats) {
    (known.has(idOf(seat)) ? reachable : unreachable).push(seat);
  }
  return { reachable, unreachable };
}

// ------------------------------------------------------------------- progress

export type CouncilPhase =
  | "idle"
  | "contracting"
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

/**
 * The parsed record of what the bench actually said, as fields.
 *
 * Kept beside the prose rather than instead of it: the synthesis is still the
 * thing a person reads, and this is the thing a surface renders.
 */
export interface CouncilDossier {
  synthesis: CouncilSynthesis;
  judges: (JudgeReading & { model: string; emphasis: Emphasis; error?: string | null })[];
  tally: RankingTally[];
  winnerSource: WinnerDecision["source"];
  /** Set when the judges' scoreboard did not agree with the synthesis. */
  disagreement: string;
}

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
  /** The parsed dossier, when the run got as far as a synthesis. */
  dossier?: CouncilDossier | null;
  /** What the readers agreed the problem asks, before anybody answered it. */
  contract?: ProblemContract | null;
  contractAgreement?: ContractAgreement | null;
  /** The dossier rendered for a reader: standing, evidence, dissent. */
  presentation?: Presentation | null;
  /** Orthogonal checks on the harness itself, when any were run. */
  oracles?: OracleSignal[];
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
  knowledge?: string;
}): string {
  const parts = [
    "The problem:\n" + (args.question || "(see the candidates' restatements)"),
    // The library, in the one round that never had it. Revision is where a
    // solver rewrites its algorithm after being told what is wrong with it —
    // the round most likely to need the technique note, and the only round the
    // knowledge pack was not reaching.
    args.knowledge?.trim() ? "Local Knowledge/RAG guidance:\n" + args.knowledge.trim() : "",
    `Your earlier answer was Candidate ${args.letter}:\n${args.ownRaw}`,
    "The full field:\n\n" + args.docket,
    "What the council said about yours:\n" + (args.received || "(no stanza addressed to you)"),
  ].filter(Boolean);
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

// -------------------------------------------------- the problem contract

/**
 * What the problem actually asks, agreed before anybody answers it.
 *
 * Solvers each restate the question in their own words, and every later stage
 * inherits whichever restatement it happened to read: the harness tests the
 * spec writer's reading, the reviewers grade against their own, and a
 * disagreement about what the problem *is* surfaces as a disagreement about who
 * is correct. That is expensive to unpick and impossible to see from the
 * outside.
 *
 * So the reading happens once, up front, in fields — the same idea as a task
 * contract in HumanEval+ or SWE-bench — and is injected verbatim into every
 * prompt afterwards. Two readers rather than one because a single misreading
 * is otherwise promoted to ground truth, and a contract nobody can contradict
 * is worse than no contract at all.
 */
export interface ProblemContract {
  kind: string;
  languages: string[];
  signature: string;
  inputs: string;
  outputs: string;
  constraints: string;
  examples: string;
  edgeCases: string;
  complexity: string;
  /** What the reader could not determine from the problem as given. */
  unknowns: string;
  raw: string;
  wellFormed: boolean;
}

const CONTRACT_BLOCK = /<<<CONTRACT\s*([\s\S]*?)\s*CONTRACT>>>/i;

const CONTRACT_LABELS: [string, string[]][] = [
  ["kind", ["KIND"]],
  ["languages", ["LANGUAGES", "LANGUAGE"]],
  ["signature", ["SIGNATURE", "SIGNATURES"]],
  ["inputs", ["INPUTS", "INPUT"]],
  ["outputs", ["OUTPUTS", "OUTPUT"]],
  ["constraints", ["CONSTRAINTS"]],
  ["examples", ["EXAMPLES", "EXAMPLE"]],
  ["edgeCases", ["EDGE CASES", "EDGES"]],
  ["complexity", ["COMPLEXITY"]],
  ["unknowns", ["UNKNOWNS", "UNKNOWN"]],
];

const EMPTY_CONTRACT: ProblemContract = {
  kind: "",
  languages: [],
  signature: "",
  inputs: "",
  outputs: "",
  constraints: "",
  examples: "",
  edgeCases: "",
  complexity: "",
  unknowns: "",
  raw: "",
  wellFormed: false,
};

export function parseProblemContract(text: string): ProblemContract {
  const match = (text || "").match(CONTRACT_BLOCK);
  const body = match ? match[1] : text || "";
  const { fields, matched } = readLabels(body, CONTRACT_LABELS);
  if (!matched) return { ...EMPTY_CONTRACT, raw: (text || "").trim().slice(0, 2000) };
  return {
    kind: fields.kind.split("\n")[0].trim().toLowerCase(),
    languages: fields.languages
      .split("\n")[0]
      .split(/[,/]/)
      .map((x) => normalizeCodeLanguage(x))
      .filter(Boolean),
    signature: fields.signature,
    inputs: fields.inputs,
    outputs: fields.outputs,
    constraints: fields.constraints,
    examples: fields.examples,
    edgeCases: fields.edgeCases,
    complexity: fields.complexity,
    unknowns: fields.unknowns,
    raw: (match ? match[0] : text || "").trim(),
    wellFormed: true,
  };
}

const flatten = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();

/** Where two independent readings of the same problem parted company. */
export interface ContractAgreement {
  agree: boolean;
  /** One line per field that differs, in the words both readers used. */
  differences: string[];
}

/**
 * Two readings compared on the fields a wrong answer would turn on.
 *
 * Prose fields are compared loosely — whitespace and case folded — because two
 * readers writing the same constraint in different words agree, and treating
 * that as a conflict would mark every run disputed and teach everyone to ignore
 * the flag. Only the fields that change what a correct program does are
 * compared at all: two readers listing different edge cases have both read the
 * problem correctly and are simply being thorough in different directions.
 */
export function compareProblemContracts(a: ProblemContract, b: ProblemContract): ContractAgreement {
  const differences: string[] = [];
  const check = (label: string, x: string, y: string) => {
    if (!x.trim() || !y.trim()) return;
    if (flatten(x) !== flatten(y)) differences.push(`${label}: reader 1 says "${x.trim()}"; reader 2 says "${y.trim()}"`);
  };
  check("SIGNATURE", a.signature, b.signature);
  check("INPUTS", a.inputs, b.inputs);
  check("OUTPUTS", a.outputs, b.outputs);
  check("CONSTRAINTS", a.constraints, b.constraints);
  if (a.kind && b.kind && a.kind !== b.kind) differences.push(`KIND: "${a.kind}" against "${b.kind}"`);
  return { agree: differences.length === 0, differences };
}

/**
 * One contract from two readings.
 *
 * The first well-formed reading is the base; the second fills in only what the
 * first left blank. A field the two disagree on is never merged or averaged —
 * the disagreement is carried into `unknowns`, where every later prompt reads
 * it, because a contract that hides its own uncertainty is how a misreading
 * becomes ground truth.
 */
export function mergeProblemContracts(
  readings: ProblemContract[]
): { contract: ProblemContract | null; agreement: ContractAgreement } {
  const good = readings.filter((r) => r?.wellFormed);
  if (!good.length) return { contract: null, agreement: { agree: false, differences: [] } };
  const [base, second] = good;
  if (!second) return { contract: base, agreement: { agree: true, differences: [] } };

  const agreement = compareProblemContracts(base, second);
  const pick = (x: string, y: string) => (x.trim() ? x : y);
  const merged: ProblemContract = {
    kind: base.kind || second.kind,
    languages: Array.from(new Set([...base.languages, ...second.languages])),
    signature: pick(base.signature, second.signature),
    inputs: pick(base.inputs, second.inputs),
    outputs: pick(base.outputs, second.outputs),
    constraints: pick(base.constraints, second.constraints),
    examples: pick(base.examples, second.examples),
    edgeCases: [base.edgeCases, second.edgeCases].filter((x) => x.trim()).join("\n"),
    complexity: pick(base.complexity, second.complexity),
    unknowns: [
      base.unknowns,
      second.unknowns,
      ...agreement.differences.map((d) => `The two readers disagreed — ${d}`),
    ]
      .filter((x) => x.trim())
      .join("\n"),
    raw: base.raw,
    wellFormed: true,
  };
  return { contract: merged, agreement };
}

export function contractSystemPrompt(): string {
  return [
    "You read a problem statement and write down what it asks, as fields. You do not solve it.",
    "Nothing you write may be inferred from a solution you have in mind: if the statement does",
    "not say it, it goes under UNKNOWNS rather than being filled in with what is usual.",
    "",
    "Output one block, exactly once, and no commentary:",
    "",
    "<<<CONTRACT",
    "KIND: code | mcq | math | research",
    "LANGUAGES: <languages the answer must be written in, or 'any'>",
    "SIGNATURE: <the exact function or class signature required, or 'none given'>",
    "INPUTS: <each parameter, its type and meaning>",
    "OUTPUTS: <what is returned or printed, and in what form>",
    "CONSTRAINTS: <bounds on sizes, values, time and memory, exactly as stated>",
    "EXAMPLES: <the worked examples from the statement, input -> output>",
    "EDGE CASES: <cases the statement implies: empty, one element, duplicates, overflow>",
    "COMPLEXITY: <the complexity the statement demands or implies, or 'not stated'>",
    "UNKNOWNS: <anything the statement leaves genuinely undetermined>",
    "CONTRACT>>>",
  ].join("\n");
}

export function contractUserPrompt(args: { question: string; reading?: string }): string {
  return [
    "The problem, as given:\n" + (args.question || "(the problem is in the attached image)"),
    args.reading?.trim() ? "A transcription of the screen:\n" + args.reading.trim() : "",
    "Write the contract.",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/**
 * The contract as it appears in every later prompt.
 *
 * Stated as ground truth, with one deliberate exception: the fields the readers
 * disagreed on are named as disputed rather than asserted. A solver told
 * confidently that the signature is one thing when it may be another writes the
 * wrong program with no way of noticing.
 */
/**
 * The contract as a retrieval query.
 *
 * The knowledge library matches text against text, which is why the cloud
 * worker could not consult it until the solvers had written something: a
 * screenshot is not a query. The contract is — it describes the problem, in
 * words, before anyone has attempted it, which is both earlier and less biased
 * than retrieving against one model's attempt.
 */
export function contractQuery(contract: ProblemContract | null): string {
  if (!contract?.wellFormed) return "";
  return [
    contract.signature,
    contract.inputs,
    contract.outputs,
    contract.constraints,
    contract.examples,
    contract.edgeCases,
    contract.complexity,
    contract.languages.join(" "),
  ]
    .map((x) => (x || "").trim())
    .filter(Boolean)
    .join("\n");
}

export function contractBlock(contract: ProblemContract | null): string {
  if (!contract?.wellFormed) return "";
  const rows: [string, string][] = [
    ["KIND", contract.kind],
    ["LANGUAGES", contract.languages.join(", ")],
    ["SIGNATURE", contract.signature],
    ["INPUTS", contract.inputs],
    ["OUTPUTS", contract.outputs],
    ["CONSTRAINTS", contract.constraints],
    ["EXAMPLES", contract.examples],
    ["EDGE CASES", contract.edgeCases],
    ["COMPLEXITY", contract.complexity],
    ["UNDETERMINED", contract.unknowns],
  ];
  const body = rows
    .filter(([, value]) => value && value.trim())
    .map(([label, value]) => `${label}: ${value.trim()}`)
    .join("\n");
  if (!body) return "";
  return [
    "PROBLEM CONTRACT (read independently before anyone answered; treat as the problem's own words):",
    body,
    "Anything under UNDETERMINED is genuinely unsettled — say which reading you assumed rather than",
    "picking one silently.",
  ].join("\n");
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
    "Java only: the entry class must be named exactly `Main` and hold `public static void",
    "main(String[])`. Do not declare any other class `public` — the runner compiles the whole",
    "harness as one Main.java, and a second public class in one file will not compile.",
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
          (run.remoteElapsedMs != null ? `, measured ${run.remoteElapsedMs}ms` : "") +
          (run.peakMemoryKb != null ? `, peak ${Math.round(run.peakMemoryKb / 1024 * 10) / 10}MB` : "") +
          (run.remote
            ? `; remote ${run.remote.ok ? "OK" : "FAILED"} on ${run.remote.runner || run.remote.codespace || "unknown runner"}, ` +
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

// -------------------------------------------------- the structured dossier

/**
 * Reading the labelled sections back out of a synthesis or a judge report.
 *
 * Same reasoning as `parseVerdict` in verdict.ts: the models answer in flat
 * `LABEL: text` lines because that survives a language model far better than
 * JSON, and the cost of that choice is a parser here rather than a schema
 * there. Two rules earn their keep:
 *
 * 1. Only known labels split the text. A model writing "Note: ..." mid-answer
 *    must not silently truncate the section it is in.
 * 2. Nothing inside a fenced code block is ever a label. Shipped code says
 *    `# Complexity: O(n)` all the time, and a parser that treats that as a new
 *    section cuts the answer in half exactly where a user would paste it.
 */
function readLabels(
  text: string,
  labels: [string, string[]][]
): { fields: Record<string, string>; preamble: string; matched: boolean } {
  const fields: Record<string, string> = {};
  const buffer: Record<string, string[]> = {};
  const preamble: string[] = [];
  let current = "";
  let fenced = false;
  let matched = false;

  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      if (current) buffer[current].push(raw);
      else preamble.push(raw);
      continue;
    }
    const bare = fenced ? "" : raw.replace(/\*\*/g, "").replace(/^\s*[-*]\s+/, "").replace(/^\s*#+\s*/, "");
    const m = fenced ? null : /^\s*([A-Za-z][A-Za-z ]{2,20}?)\s*:\s*(.*)$/.exec(bare);
    let hit = "";
    if (m) {
      const label = m[1].trim().toUpperCase();
      for (const [key, names] of labels) {
        if (names.includes(label)) {
          hit = key;
          break;
        }
      }
    }
    if (hit) {
      matched = true;
      current = hit;
      buffer[current] = buffer[current] ?? [];
      if (m![2].trim()) buffer[current].push(m![2].trim());
      continue;
    }
    if (current) buffer[current].push(raw);
    else if (raw.trim()) preamble.push(raw);
  }

  for (const [key] of labels) fields[key] = (buffer[key] ?? []).join("\n").trim();
  return { fields, preamble: preamble.join("\n").trim(), matched };
}

/** Letters named in a line, in the order they were named. `A > C > B` → A,C,B. */
function lettersInOrder(line: string): string[] {
  const out: string[] = [];
  for (const m of (line || "").matchAll(/\b([A-Z])\b/g)) {
    if (!LETTERS.includes(m[1])) continue;
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** The first fenced block in a body, with whatever language the fence named. */
function firstFence(body: string): { code: string; language: string } {
  const m = /```([A-Za-z0-9+#._-]*)\s*\n([\s\S]*?)```/.exec(body || "");
  if (!m) return { code: "", language: "" };
  return { code: m[2].trim(), language: normalizeCodeLanguage(m[1] || "") };
}

/** The synthesis, as fields rather than prose. */
export interface CouncilSynthesis {
  verdict: string;
  /** The letter the synthesis named, or "" for NONE / unparsable. */
  winner: string;
  rejected: string;
  evidence: string;
  approach: string;
  finalAnswer: string;
  /** The first fenced block of FINAL ANSWER — what a user would paste. */
  code: string;
  language: string;
  preamble: string;
  /** False when not one labelled section was found. */
  wellFormed: boolean;
}

const SYNTHESIS_LABELS: [string, string[]][] = [
  ["verdict", ["VERDICT"]],
  ["winner", ["WINNER"]],
  ["rejected", ["REJECTED"]],
  ["evidence", ["EVIDENCE"]],
  ["approach", ["APPROACH"]],
  ["finalAnswer", ["FINAL ANSWER", "FINAL"]],
];

/**
 * The synthesis is the one artefact every downstream surface reads, and until
 * now only its `WINNER:` line was ever read by code — everything else was
 * scraped out of markdown by whoever was rendering it, or not shown at all.
 * Parsing it once, here, is what lets the panel and the helper overlay show
 * *why* an answer is trusted without either of them re-reading prose.
 */
export function parseCouncilSynthesis(text: string): CouncilSynthesis {
  const { fields, preamble, matched } = readLabels(text || "", SYNTHESIS_LABELS);
  const winnerRaw = fields.winner || "";
  const winnerMatch = /^\s*([A-Z])\b/.exec(winnerRaw.replace(/^\**/, ""));
  const winner =
    winnerMatch && !/^\s*NONE\b/i.test(winnerRaw) && LETTERS.includes(winnerMatch[1]) ? winnerMatch[1] : "";
  const fence = firstFence(fields.finalAnswer);
  return {
    verdict: fields.verdict,
    winner,
    rejected: fields.rejected,
    evidence: fields.evidence,
    approach: fields.approach,
    finalAnswer: fields.finalAnswer,
    code: fence.code,
    language: fence.language,
    preamble,
    wellFormed: matched,
  };
}

/** One judge's report, as fields. */
export interface JudgeReading {
  verdict: string;
  /** Letters best-first, as the judge ordered them. */
  ranking: string[];
  /** Letters the judge said it verified correct itself. */
  correct: string[];
  why: string;
  defects: string;
  best: string;
  preamble: string;
  wellFormed: boolean;
}

const JUDGE_LABELS: [string, string[]][] = [
  ["verdict", ["VERDICT"]],
  ["ranking", ["RANKING", "RANK"]],
  ["correct", ["CORRECT"]],
  ["why", ["WHY"]],
  ["defects", ["DEFECTS"]],
  ["best", ["BEST ANSWER", "BEST"]],
];

export function parseJudgeReport(text: string): JudgeReading {
  const { fields, preamble, matched } = readLabels(text || "", JUDGE_LABELS);
  return {
    verdict: fields.verdict,
    ranking: lettersInOrder(fields.ranking.split("\n")[0] || ""),
    correct: lettersInOrder(fields.correct.split("\n")[0] || ""),
    why: fields.why,
    defects: fields.defects,
    best: fields.best,
    preamble,
    wellFormed: matched,
  };
}

// ------------------------------------------------ the deterministic winner

/** One candidate's standing on the judges' scoreboard. */
export interface RankingTally {
  letter: string;
  /** Borda points: a first place among n candidates is worth n, a last is 1. */
  points: number;
  firsts: number;
  /** How many judges said they verified this one correct themselves. */
  correctVotes: number;
  gate: "pass" | "fail" | "untested";
}

/**
 * The judges' rankings, counted rather than read.
 *
 * Borda rather than "who got the most firsts": with three judges and four
 * candidates, a candidate ranked second by everyone is a better answer than one
 * ranked first by a single judge and last by the other two, and plurality
 * cannot see the difference. Judges who ranked only part of the field still
 * count — an unranked candidate simply scores nothing from that judge, which is
 * what leaving it out means.
 */
export function aggregateJudgeRankings(
  reports: JudgeReading[],
  letters: string[],
  runs: Record<string, CandidateRun> = {}
): RankingTally[] {
  const size = Math.max(letters.length, 1);
  const tally = new Map<string, RankingTally>();
  for (const letter of letters) {
    tally.set(letter, { letter, points: 0, firsts: 0, correctVotes: 0, gate: gateFor(runs[letter]) });
  }
  for (const report of reports) {
    report.ranking.forEach((letter, index) => {
      const row = tally.get(letter);
      if (!row) return;
      row.points += Math.max(size - index, 1);
      if (index === 0) row.firsts += 1;
    });
    for (const letter of report.correct) {
      const row = tally.get(letter);
      if (row) row.correctVotes += 1;
    }
  }
  return [...tally.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.firsts - a.firsts ||
      b.correctVotes - a.correctVotes ||
      a.letter.localeCompare(b.letter)
  );
}

/** What the deterministic layer decided, and on whose evidence. */
export interface WinnerDecision {
  winner: string;
  /** Where the surviving winner came from. */
  source: "synthesis" | "judges" | "evidence" | "none";
  /** Set when the gate rejected the synthesis' pick. */
  overruledReason: string;
  /** Set when the judges' scoreboard did not agree with the synthesis. */
  disagreement: string;
  tally: RankingTally[];
}

/**
 * Winner selection, moved out of the synthesis and into code.
 *
 * The synthesis used to do two jobs at once: score the field and narrate the
 * result. Only one of those needs a language model. Scoring is counting, and a
 * model that counts in prose can be argued with — by itself, mid-paragraph, as
 * the first real run showed when it reinterpreted a failed execution until the
 * gate appeared not to apply.
 *
 * So the order here is: the gate first (execution beats everything), then the
 * judges' counted scoreboard, and the synthesis last, as the narrator. A
 * synthesis pick that clears the gate normally stands — it read the same
 * evidence and it wrote the answer text. It is displaced only when the judges
 * put a *gate-passing* candidate strictly above it, which is the one case where
 * the prose and the arithmetic genuinely disagree, and the disagreement is
 * recorded either way so a reader can see it happened.
 */
export function decideWinner(args: {
  claimed: string;
  judges: JudgeReading[];
  runs: Record<string, CandidateRun>;
  letters: string[];
}): WinnerDecision {
  const tally = aggregateJudgeRankings(args.judges, args.letters, args.runs);
  const ruling = enforceWinnerGate(args.claimed, args.runs);
  const executed = Object.values(args.runs).some((r) => r?.ran);
  // Verified execution outranks syntheses and judge popularity.
  // Keep the original judge/synthesis policy for reasoning-only questions.
  if (executed) {
    const evidence = selectVerifiedCandidate(args.runs);
    if (!evidence.winner) {
      return { winner: "", source: "none", overruledReason: ruling.overruledReason,
        disagreement: evidence.reason, tally };
    }
    return { winner: evidence.winner, source: "evidence", overruledReason: ruling.overruledReason,
      disagreement: args.claimed && args.claimed !== evidence.winner
        ? `The synthesis preferred Candidate ${args.claimed}, but ${evidence.reason}`
        : evidence.reason, tally };
  }
  const eligible = tally.filter((row) => (executed ? row.gate === "pass" : true) && row.points > 0);
  const leader = eligible[0];

  if (ruling.winner) {
    const claimedRow = tally.find((row) => row.letter === ruling.winner);
    if (leader && leader.letter !== ruling.winner && leader.points > (claimedRow?.points ?? 0)) {
      return {
        winner: leader.letter,
        source: "judges",
        overruledReason: ruling.overruledReason,
        disagreement:
          `The synthesis shipped Candidate ${ruling.winner}, but the judges ranked Candidate ${leader.letter} ` +
          `higher (${leader.points} points to ${claimedRow?.points ?? 0}) and its run passed. The counted ` +
          `scoreboard decides the winner; read the synthesis for the reasoning, not for the result.`,
        tally,
      };
    }
    return { winner: ruling.winner, source: "synthesis", overruledReason: "", disagreement: "", tally };
  }

  // The synthesis named nobody the gate would accept. A gate-passing candidate
  // the judges ranked is still a better answer than silence, and saying so is
  // the difference between "we found nothing" and "we found something and threw
  // it away because one model wrote the wrong letter on the envelope".
  if (leader) {
    return {
      winner: leader.letter,
      source: "judges",
      overruledReason: ruling.overruledReason,
      disagreement: args.claimed
        ? `Candidate ${args.claimed} did not survive the gate, so the judges' highest-ranked passing ` +
          `candidate, ${leader.letter}, is recorded as the winner instead.`
        : `The synthesis named no winner. Candidate ${leader.letter} passed its run and the judges ranked ` +
          `it highest, so it is recorded as the winner.`,
      tally,
    };
  }

  return { winner: "", source: "none", overruledReason: ruling.overruledReason, disagreement: "", tally };
}

// ------------------------------------------------------------- oracles

/**
 * A deliberately broken version of a candidate's code.
 *
 * The generated harness is one model's opinion about what correct means, and a
 * suite that passes everything it is given proves nothing at all — which is the
 * failure mode the whole gate is blind to, because a gate can only reject what
 * its evidence rejects. The cheapest way to find out whether a suite
 * discriminates is to hand it something that is definitely wrong and see if it
 * notices.
 *
 * The mutation is textual and language-agnostic on purpose: the point is not to
 * model the program, it is to break it. Comparisons flip, arithmetic flips, and
 * failing that a returned value is replaced with a constant. Any of those makes
 * a correct program incorrect for almost every input a real test battery uses.
 */
export interface Mutation {
  applied: boolean;
  /** What was changed, in one line, for the evidence log. */
  description: string;
  code: string;
}

const MUTATIONS: [RegExp, string, string][] = [
  [/(?<![<>=!])<=(?!=)/, ">=", "flipped the first <= to >="],
  [/(?<![<>=!])>=(?!=)/, "<=", "flipped the first >= to <="],
  [/(?<![<>=!+-])<(?![=<])/, ">", "flipped the first < to >"],
  [/(?<![<>=!+-])>(?![=>])/, "<", "flipped the first > to <"],
  [/(?<![=!<>+\-*/%])==(?!=)/, "!=", "flipped the first == to !="],
  [/\s\+\s/, " - ", "turned the first addition into a subtraction"],
];

export function mutateCode(code: string): Mutation {
  const body = code || "";
  if (!body.trim()) return { applied: false, description: "", code: body };
  for (const [pattern, replacement, description] of MUTATIONS) {
    if (pattern.test(body)) {
      return { applied: true, description, code: body.replace(pattern, replacement) };
    }
  }
  return { applied: false, description: "nothing mechanical left to break", code: body };
}

/** One orthogonal signal about the harness itself, not about a candidate. */
export interface OracleSignal {
  kind: "mutation";
  /** The candidate the mutant was made from. */
  letter: string;
  ran: boolean;
  /** True when the harness passed a program that was deliberately broken. */
  survived: boolean;
  description: string;
  note: string;
}

/** The oracle findings, as evidence lines beside the execution digest. */
export function oracleDigest(signals: OracleSignal[]): string {
  const lines = signals
    .filter((s) => s.ran)
    .map((s) =>
      s.survived
        ? `Mutation check on Candidate ${s.letter}: the harness PASSED a program that had been deliberately broken (${s.description}).`
        : `Mutation check on Candidate ${s.letter}: the harness correctly rejected a deliberately broken version (${s.description}).`
    );
  return lines.join("\n");
}

/**
 * Whether the oracles think the harness is worth believing.
 *
 * Deliberately does not touch the gate. A suite that passes a broken program is
 * not evidence that any candidate is wrong, and promoting or demoting anyone on
 * this signal would be inventing a result. It goes in front of the judges, in
 * words, where a human can see it — the same treatment `harnessIsSuspect` gets
 * and for the same reason.
 */
export function oracleSuspicion(signals: OracleSignal[]): string {
  const survived = signals.filter((s) => s.ran && s.survived);
  if (!survived.length) return "";
  const letters = survived.map((s) => s.letter).join(", ");
  return (
    `The generated harness passed a deliberately broken version of Candidate(s) ${letters} ` +
    `(${survived[0].description}). A suite that accepts a program known to be wrong has not ` +
    `verified the ones it accepted either: treat every PASS on this harness as unproven, and ` +
    `say which specific case should have caught the break.`
  );
}

// ---------------------------------------------------------- presentation

/** One candidate's line on the evidence table. */
export interface EvidenceRow {
  letter: string;
  model: string;
  gate: "pass" | "fail" | "untested";
  passed: number;
  failed: number;
  /** Whether this row describes the revision rather than the first answer. */
  revised: boolean;
  runtime: string;
  durationMs: number;
  elapsedMs: number | null;
  peakMemoryKb: number | null;
  note: string;
  /** Borda points from the judges, when the dossier was parsed. */
  judgePoints: number;
}

/**
 * Everything a surface needs to explain the answer, without another model call.
 *
 * The overlay's thought-process panes were decorative because nothing produced
 * the thoughts in a form they could render: the reasoning existed only inside a
 * synthesis paragraph, and the helper's answer was "here is some code" with no
 * account of why anyone should trust it. This is that account, as fields.
 */
export interface Presentation {
  standing: AnswerStanding["standing"];
  standingReason: string;
  winner: string;
  /** Which authority produced the winner: the synthesis, or the judges' tally. */
  winnerSource: WinnerDecision["source"];
  /** "Candidate B — z-ai/glm-5.3". Naming the model is safe after the gate. */
  provenance: string;
  approach: string;
  complexity: string;
  evidence: EvidenceRow[];
  /** Where the bench did not agree, in one line each. */
  dissent: string[];
  /** What was rejected and why, as the synthesis put it. */
  rejected: string[];
  /** Non-empty when independent candidates failed identically. */
  harnessSuspect: string;
  /** Where the two problem readings parted company, if they did. */
  contractDisputes: string[];
  /** The code a user would paste, and what it is written in. */
  code: string;
  language: string;
}

const bullets = (body: string): string[] =>
  (body || "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);

export function buildPresentation(report: CouncilReport): Presentation {
  // A revised candidate is represented by its revision everywhere: that is the
  // thing that was judged, and showing round one's numbers beside a revised
  // answer would be evidence for a program nobody shipped.
  const runFor = (c: Candidate) => (c.revised ? report.revisedRuns?.[c.letter] : undefined) ?? report.runs?.[c.letter];
  const gateRuns: Record<string, CandidateRun> = {};
  for (const c of report.candidates) {
    const run = runFor(c);
    if (run) gateRuns[c.letter] = run;
  }
  const standing = answerStanding(report.winner, gateRuns);
  const points = new Map((report.dossier?.tally ?? []).map((row) => [row.letter, row.points]));

  const evidence: EvidenceRow[] = report.candidates.map((c) => {
    const run = runFor(c);
    return {
      letter: c.letter,
      model: c.model,
      gate: gateFor(run),
      passed: run?.passed ?? 0,
      failed: run?.failed ?? 0,
      revised: Boolean(c.revised && report.revisedRuns?.[c.letter]),
      runtime: run?.runtime ?? "",
      durationMs: run?.durationMs ?? 0,
      elapsedMs: run?.remote?.remoteElapsedMs ?? run?.remoteElapsedMs ?? null,
      peakMemoryKb: run?.remote?.peakMemoryKb ?? run?.peakMemoryKb ?? null,
      note: run?.note ?? "",
      judgePoints: points.get(c.letter) ?? 0,
    };
  });

  // Dissent is the part a review committee publishes and a consensus machine
  // hides: a judge who ranked the losing candidate first was not wrong to, and
  // a reader who can see that disagreement can weigh it.
  const dissent: string[] = [];
  if (report.dossier?.disagreement) dissent.push(report.dossier.disagreement);
  for (const judge of report.dossier?.judges ?? []) {
    const top = judge.ranking[0];
    if (!top || !report.winner || top === report.winner) continue;
    const gate = gateFor(gateRuns[top]);
    dissent.push(
      `${judge.model} (${judge.emphasis}) ranked Candidate ${top} first; ` +
        (gate === "pass"
          ? `Candidate ${report.winner} was selected instead.`
          : `the execution gate ${gate === "fail" ? "rejected" : "could not verify"} Candidate ${top}.`)
    );
  }

  const winnerCandidate = report.candidates.find((c) => c.letter === report.winner);
  const winnerFinal = winnerCandidate?.revised ?? winnerCandidate?.final ?? null;
  const synth = report.dossier?.synthesis;
  return {
    standing: standing.standing,
    standingReason: standing.reason,
    winner: report.winner,
    winnerSource: report.dossier?.winnerSource ?? (report.winner ? "synthesis" : "none"),
    provenance: winnerCandidate ? `Candidate ${winnerCandidate.letter} — ${winnerCandidate.model}` : "",
    approach: synth?.approach || "",
    complexity: report.contract?.complexity || winnerFinal?.complexity || "",
    evidence,
    dissent,
    rejected: bullets(synth?.rejected || ""),
    harnessSuspect: [harnessIsSuspect(gateRuns), oracleSuspicion(report.oracles ?? [])]
      .filter(Boolean)
      .join("\n\n"),
    contractDisputes: report.contractAgreement?.differences ?? [],
    // The synthesis assembles the shipped answer, so its code is preferred; the
    // winning candidate's own code is the fallback when the synthesis wrote
    // prose around a candidate rather than restating it.
    code: synth?.code || winnerFinal?.code || "",
    language: synth?.language || (winnerFinal ? candidateLanguage(winnerFinal) : ""),
  };
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
