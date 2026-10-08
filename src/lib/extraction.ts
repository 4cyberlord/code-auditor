import { routeProblem, routingGuidance, reconcileProblemReadings } from "./problemRouting.ts";

/**
 * Turning a screenshot into structured engineering context.
 *
 * The README's principle (section 9) is that vision models read the image and
 * text models reason over what they extracted. That is what lets a model with no
 * vision at all — DeepSeek, Qwen, Codex, anything reachable through TokenRouter —
 * take part in the panel.
 *
 * The risk it introduces is a single point of failure: if one model transcribes
 * the picture and everyone else works from its text, its misreadings become
 * everyone's, silently, and the whole comparison downstream is worthless. So
 * extraction runs on *two* vision models independently and the two readings are
 * compared. A character that one read as `l` and the other as `1` surfaces as a
 * conflict instead of propagating.
 */

export interface ExtractedError {
  message: string;
  file?: string;
  line?: number;
}

export interface Extraction {
  /** What the screenshot mostly is. */
  kind: "code" | "terminal" | "browser" | "math" | "mixed" | "other";
  language: string;
  framework: string;
  fileName: string;
  filePath: string;
  /** Transcribed verbatim, including any bug. */
  code: string;
  errors: ExtractedError[];
  terminalCommands: string[];
  terminalOutput: string;
  url: string;
  /** Anything notable that is not covered by the fields above. */
  observations: string[];
  /** One or two sentences saying what is being asked. */
  problemSummary: string;
  /**
   * Characters or regions the model could not read with confidence. This is the
   * field that makes a bad transcription visible instead of plausible.
   */
  ambiguities: string[];
  confidence: number;
}

export const EMPTY_EXTRACTION: Extraction = {
  kind: "other",
  language: "",
  framework: "",
  fileName: "",
  filePath: "",
  code: "",
  errors: [],
  terminalCommands: [],
  terminalOutput: "",
  url: "",
  observations: [],
  problemSummary: "",
  ambiguities: [],
  confidence: 0,
};

// ------------------------------------------------------------------- prompt

export const EXTRACTION_SYSTEM = `
You are reading a screenshot and turning it into structured data. You are not
solving anything — another model will do that from what you produce, and it will
never see the picture. Everything it needs has to be in your output.

Describe important visual relationships explicitly in "observations": edges,
node positions, arrows, labels, axes, camera/icon placement, and before/after
diagrams. Do NOT interpret an example output as the only accepted output when
multiple valid outputs are indicated. For any obscured image portion, record
the uncertainty in "ambiguities"; never silently invent missing structure.

Transcribe exactly what is on screen. If the code contains a bug, transcribe the
bug; do not correct it. If a line is cut off, say so rather than completing it.

Screenshots are photographs of screens: expect glare, compression and cropping.
When a character is genuinely ambiguous — l/1/I, O/0, rn/m, .-, — choose the
reading the surrounding syntax supports and record the doubt in "ambiguities".
An unrecorded guess is the failure that matters here, because everything
downstream will treat your transcription as fact.

Reply with one JSON object and nothing else:

{
  "kind": "code" | "terminal" | "browser" | "math" | "mixed" | "other",
  "language": "",
  "framework": "",
  "fileName": "",
  "filePath": "",
  "code": "",
  "errors": [{ "message": "", "file": "", "line": 0 }],
  "terminalCommands": [],
  "terminalOutput": "",
  "url": "",
  "observations": [],
  "problemSummary": "",
  "ambiguities": [],
  "confidence": 0.0
}

Use "" or [] for anything not present. Do not invent a file name, a URL or a
framework that is not visible. "confidence" is how much you trust your own
transcription, not how solvable the problem looks.`.trim();

export function extractionUserPrompt(note: string, manifest = "", ocrHint = ""): string {
  const parts = [
    manifest
      ? "Read the attached images and return one JSON object describing them together."
      : "Read the attached image and return the JSON object.",
  ];
  // The reader needs the ordering as much as the reasoning models do -- more so,
  // since it is producing the single text everything downstream will work from.
  // Transcribing five screenshots as five unrelated fragments loses the thing
  // that made them one problem.
  if (manifest) parts.push(manifest);
  if (note.trim()) parts.push(`The person added this context: ${note.trim()}`);
  // On-device OCR, offered as a second opinion on the characters and nothing
  // more. Apple Vision is very good at turning pixels into text and cannot see
  // a diagram, an axis or an indentation level at all, so it helps exactly
  // where transcription is hard and must never be treated as the reading: the
  // picture is what you are answering about.
  if (ocrHint.trim()) {
    parts.push(
      "An on-device OCR pass produced the text below. Use it to settle characters you are unsure of — l against 1, O against 0 — and ignore it wherever it disagrees with what you can see. It cannot see layout, diagrams or colour.\n\n" +
        ocrHint.trim()
    );
  }
  return parts.join("\n\n");
}

/** Renders an extraction as the text a non-vision model will reason over. */
export function renderForReasoning(e: Extraction): string {
  const out: string[] = [];
  if (e.problemSummary) out.push(`PROBLEM\n${e.problemSummary}`);
  const stack = [e.language, e.framework].filter(Boolean).join(" / ");
  if (stack) out.push(`STACK\n${stack}`);
  if (e.fileName || e.filePath) out.push(`FILE\n${e.filePath || e.fileName}`);
  if (e.code) out.push(`CODE\n\`\`\`${e.language}\n${e.code}\n\`\`\``);
  if (e.errors.length) {
    out.push(
      "ERRORS\n" +
        e.errors
          .map((x) => `- ${x.message}${x.file ? ` (${x.file}${x.line ? `:${x.line}` : ""})` : ""}`)
          .join("\n")
    );
  }
  if (e.terminalCommands.length) out.push(`COMMANDS\n${e.terminalCommands.join("\n")}`);
  if (e.terminalOutput) out.push(`TERMINAL OUTPUT\n${e.terminalOutput}`);
  if (e.url) out.push(`URL\n${e.url}`);
  if (e.observations.length) out.push("NOTES\n" + e.observations.map((o) => `- ${o}`).join("\n"));
  if (e.problemSummary || e.observations.length) out.push(routingGuidance(routeProblem(e)));
  if (e.ambiguities.length) {
    // Carried through deliberately. A reader who knows which characters were
    // uncertain can weigh the answer; one who does not, cannot.
    out.push(
      "UNCERTAIN IN THE SOURCE IMAGE\n" + e.ambiguities.map((a) => `- ${a}`).join("\n")
    );
  }
  return out.join("\n\n");
}

// -------------------------------------------------------------------- parse

/**
 * Pulls the JSON object out of a reply.
 *
 * Models wrap JSON in prose, in fences, or in both, and asking politely does not
 * change that reliably. Scanning for the first balanced object — while respecting
 * strings and escapes, so a `}` inside transcribed code does not end it early —
 * works regardless of what was wrapped around it.
 */
export function findJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

export function parseExtraction(text: string): Extraction | null {
  const json = findJsonObject(text);
  if (!json) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }

  const kinds = ["code", "terminal", "browser", "math", "mixed", "other"] as const;
  const kind = kinds.find((k) => k === raw.kind) ?? "other";

  const errors: ExtractedError[] = Array.isArray(raw.errors)
    ? raw.errors
        .map((e) => {
          if (typeof e === "string") return { message: e };
          if (e && typeof e === "object") {
            const o = e as Record<string, unknown>;
            const message = str(o.message);
            if (!message) return null;
            const line = typeof o.line === "number" && o.line > 0 ? o.line : undefined;
            return { message, file: str(o.file) || undefined, line };
          }
          return null;
        })
        .filter((e): e is ExtractedError => e !== null)
    : [];

  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence > 1 ? raw.confidence / 100 : raw.confidence))
      : 0;

  return {
    kind,
    language: str(raw.language),
    framework: str(raw.framework),
    fileName: str(raw.fileName),
    filePath: str(raw.filePath),
    code: str(raw.code),
    errors,
    terminalCommands: strArray(raw.terminalCommands),
    terminalOutput: str(raw.terminalOutput),
    url: str(raw.url),
    observations: strArray(raw.observations),
    problemSummary: str(raw.problemSummary),
    ambiguities: strArray(raw.ambiguities),
    confidence,
  };
}

// ------------------------------------------------------------------ compare

export interface ExtractionConflict {
  field: string;
  a: string;
  b: string;
  /** Whether this difference would change the answer. */
  severity: "high" | "low";
}

export interface ExtractionAgreement {
  conflicts: ExtractionConflict[];
  /** Merged reading: the more confident model wins each disputed field. */
  merged: Extraction;
  /** True when nothing that matters differs. */
  agree: boolean;
  summary: string;
}

/** Whitespace and trailing commas differ constantly and mean nothing. */
function normalise(code: string): string {
  return code
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/**
 * Words that carry no meaning and would inflate any overlap score.
 *
 * Deliberately short. An aggressive stop list starts deleting the words that
 * distinguish one problem from another -- "not", "all", "first", "between" are
 * exactly the difference between two similar-sounding questions.
 */
const NOISE = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "was", "were", "be", "it", "its", "this", "that", "with", "as", "at", "by",
  "from", "we", "you", "i",
]);

/**
 * How alike two pieces of prose are, 0 to 1.
 *
 * This exists because of a bug worth remembering. Two readings of the same
 * screenshot were compared field by field with string equality, which is correct
 * for a transcription -- `return 1` and `return l` differ and that difference is
 * the entire point -- and completely wrong for a summary. Asked to describe the
 * same problem in a sentence, two models produce two different sentences every
 * single time. So the panel showed "READINGS DISAGREE" on almost every run,
 * knocked the confidence down 40% for it, and taught its user to ignore the one
 * warning that would have mattered.
 *
 * Overlap of content words rather than bigrams, because paraphrase is the normal
 * case here: "return the indices of the two numbers that add to target" and
 * "find two numbers summing to the target and return their indices" share almost
 * no word *pairs* and nearly all their vocabulary.
 */
export function proseSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !NOISE.has(w))
    );
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return 1;
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** Above this, two summaries are describing the same problem. */
const SAME_PROBLEM = 0.45;
/** Below this, they are describing different ones. */
const DIFFERENT_PROBLEM = 0.25;

export function compareExtractions(a: Extraction, b: Extraction): ExtractionAgreement {
  const conflicts: ExtractionConflict[] = [];
  const add = (field: string, x: string, y: string, severity: "high" | "low") => {
    if (x.trim() !== y.trim()) conflicts.push({ field, a: x, b: y, severity });
  };

  // The transcription is the thing everything downstream depends on, so a
  // difference here is always serious.
  if (normalise(a.code) !== normalise(b.code)) {
    conflicts.push({ field: "code", a: a.code, b: b.code, severity: "high" });
  }

  // Prose, so compared by overlap rather than by equality. Only a genuine
  // difference in *what problem this is* is worth stopping a run for; different
  // wording of the same problem is the expected case and used to be reported as
  // a failure.
  const ps = a.problemSummary.trim();
  const bs = b.problemSummary.trim();
  if (ps || bs) {
    const like = proseSimilarity(ps, bs);
    if (like < DIFFERENT_PROBLEM) {
      conflicts.push({
        field: "problemSummary",
        a: a.problemSummary,
        b: b.problemSummary,
        severity: "high",
      });
    } else if (like < SAME_PROBLEM) {
      conflicts.push({
        field: "problemSummary",
        a: a.problemSummary,
        b: b.problemSummary,
        severity: "low",
      });
    }
  }
  // Error text is verbatim, so a difference is real -- `name 'qs'` versus
  // `name 'gs'` is exactly the misread this whole comparison exists to catch.
  // Only the whitespace is forgiven, because a wrapped line is not a misreading.
  const errorText = (e: Extraction) =>
    e.errors
      .map((x) => x.message.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" | ");
  add("errors", errorText(a), errorText(b), "high");

  // Terminal output is transcription too, and wraps unpredictably: the same
  // screen read twice differs in trailing spaces and blank lines far more often
  // than it differs in characters.
  if (normalise(a.terminalOutput) !== normalise(b.terminalOutput)) {
    conflicts.push({
      field: "terminalOutput",
      a: a.terminalOutput,
      b: b.terminalOutput,
      severity: "high",
    });
  }

  // Metadata being read differently is worth surfacing but rarely changes the
  // answer, so it should not drown out a genuine transcription conflict.
  add("language", a.language, b.language, "low");
  add("framework", a.framework, b.framework, "low");
  add("fileName", a.fileName, b.fileName, "low");
  add("url", a.url, b.url, "low");
  add("kind", a.kind, b.kind, "low");

  // Whichever read the image more confidently wins the disputed fields; the
  // ambiguities of both are kept, because a doubt either model had is a doubt.
  const primary = b.confidence > a.confidence ? b : a;
  const merged: Extraction = {
    ...primary,
    ambiguities: Array.from(new Set([...a.ambiguities, ...b.ambiguities])),
    observations: Array.from(new Set([...a.observations, ...b.observations])),
    // Neither reading is more trustworthy than the agreement between them.
    confidence: conflicts.some((c) => c.severity === "high")
      ? Math.min(a.confidence, b.confidence) * 0.6
      : Math.min(a.confidence, b.confidence),
  };

  const high = conflicts.filter((c) => c.severity === "high");
  const agree = high.length === 0;
  // Written to fit one line in the strip that shows it. The strip is a pointer
  // to the evidence, not the evidence: anything that needs a second sentence
  // belongs in the reading document, which is one click away and holds both
  // versions side by side.
  const summary = agree
    ? conflicts.length === 0
      ? "Both readings match."
      : `Both agree; ${conflicts.length} minor ${
          conflicts.length === 1 ? "difference" : "differences"
        } in metadata.`
    : `Readings disagree on ${high.map((c) => c.field).join(", ")} — both are in the reading document.`;

  return { conflicts, merged, agree, summary };
}

/**
 * The agreement shape for a single reading.
 *
 * Sometimes only one extractor has a key, or the second reply is unparseable.
 * The run should still go ahead — one reading beats none — but the fact that
 * nothing checked it has to travel with it, because the whole reason extraction
 * is trustworthy at all is that two models agreed.
 */
/**
 * Which models should look at the picture, in order.
 *
 * Reading a screenshot of code, a chart or a diagram is a different skill from
 * solving the problem in it, and the models are not equally good at it. This is
 * the running order — strongest visual reader first — and it is data rather
 * than a hardcoded choice so a roster change is a list edit.
 *
 * Apple Vision is deliberately absent. It is the fastest, cheapest transcriber
 * available and it cannot see a graph, an indentation level or a UI at all, so
 * it belongs beside these as a hint (`extractionUserPrompt`), never as the
 * system's eyes.
 */
export const VISION_PREFERENCE: string[] = [
  "openai/gpt-5.6-sol",
  "anthropic/claude-opus-5",
  "openai/gpt-5.3-codex",
  "google/gemini-3.7-flash",
  "x-ai/grok-4.6",
];

export interface ReaderChoice<T> {
  /** The two that read independently. */
  readers: T[];
  /** The third, asked only when the two disagree. Null when there is no third. */
  tieBreaker: T | null;
}

/**
 * Two readers and an adjudicator, chosen by preference and then by whatever is
 * left.
 *
 * The tie-breaker is deliberately a *different* model from both readers: asking
 * one of the two which of the two was right is asking it whether it was wrong.
 */
export function chooseReaders<T>(
  candidates: T[],
  idOf: (item: T) => string,
  preference: string[] = VISION_PREFERENCE,
  count = 2
): ReaderChoice<T> {
  const rank = (item: T) => {
    const i = preference.indexOf(idOf(item));
    return i === -1 ? preference.length : i;
  };
  const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));
  return { readers: ordered.slice(0, count), tieBreaker: ordered[count] ?? null };
}

/** How a disputed field was settled. */
export interface TieBreak {
  field: string;
  choice: "a" | "b";
}

export function tieBreakSystemPrompt(): string {
  return [
    "Two models read the same screenshot and disagree. You are looking at the same picture, and your",
    "only job is to say which of them read it correctly, field by field. You are not solving anything.",
    "",
    "For each field you are given, answer with the letter of the reading that matches the image. Where",
    "both are wrong, pick the closer one — a later stage will still be told there was a conflict.",
    "",
    "Answer with one line per field and nothing else:",
    "FIELD: A",
    "FIELD: B",
  ].join("\n");
}

export function tieBreakUserPrompt(conflicts: ExtractionConflict[], manifest = ""): string {
  const parts = [manifest, "The disputed fields:"].filter(Boolean);
  for (const c of conflicts) {
    parts.push(
      `### ${c.field}\nA:\n${(c.a || "(nothing)").slice(0, 4000)}\n\nB:\n${(c.b || "(nothing)").slice(0, 4000)}`
    );
  }
  parts.push("Which reading matches the screenshot, for each field?");
  return parts.join("\n\n");
}

export function parseTieBreak(text: string, fields: string[]): TieBreak[] {
  const out: TieBreak[] = [];
  for (const field of fields) {
    const m = new RegExp(`^\\s*${field}\\s*:\\s*\\**\\s*([AB])\\b`, "im").exec(text || "");
    if (m) out.push({ field, choice: m[1].toUpperCase() === "A" ? "a" : "b" });
  }
  return out;
}

/**
 * The reading that survives adjudication.
 *
 * Only the disputed fields move: everything the two readers agreed on is
 * already in the merged reading, and re-deriving it from the adjudicator's
 * answer would let a third model quietly rewrite text nobody disputed.
 *
 * The result is still reported as having had a conflict. A settled disagreement
 * is not the same as never having one, and a run where two strong readers saw
 * different code is worth knowing about even when a third broke the tie.
 */
export function applyTieBreak(
  a: Extraction,
  b: Extraction,
  agreement: ExtractionAgreement,
  picks: TieBreak[],
  by: string
): ExtractionAgreement {
  if (!picks.length) return agreement;
  const merged: Extraction = { ...agreement.merged };
  const settled: string[] = [];
  for (const pick of picks) {
    const source = pick.choice === "a" ? a : b;
    switch (pick.field) {
      case "code":
        merged.code = source.code;
        break;
      case "problemSummary":
        merged.problemSummary = source.problemSummary;
        break;
      case "errors":
        merged.errors = source.errors;
        break;
      case "terminalOutput":
        merged.terminalOutput = source.terminalOutput;
        break;
      case "language":
        merged.language = source.language;
        break;
      case "framework":
        merged.framework = source.framework;
        break;
      case "fileName":
        merged.fileName = source.fileName;
        break;
      case "url":
        merged.url = source.url;
        break;
      case "kind":
        merged.kind = source.kind;
        break;
      default:
        continue;
    }
    settled.push(`${pick.field} → ${pick.choice.toUpperCase()}`);
  }
  if (!settled.length) return agreement;

  const high = agreement.conflicts.filter((c) => c.severity === "high").map((c) => c.field);
  const unresolved = high.filter((field) => !picks.some((p) => p.field === field));
  return {
    ...agreement,
    merged,
    // Resolved is not the same as never disputed, and an unresolved field means
    // the doubt still stands.
    agree: unresolved.length === 0,
    summary:
      `The readers disagreed on ${high.join(", ") || "metadata"}; ${by} looked and settled ${settled.join(", ")}.` +
      (unresolved.length ? ` Still unsettled: ${unresolved.join(", ")}.` : ""),
  };
}

export function singleReading(e: Extraction, why = ""): ExtractionAgreement {
  return {
    conflicts: [],
    merged: e,
    agree: true,
    // Short on purpose. The warning that used to follow — that a misread
    // character reaches every agent as fact — is true, and it was also three
    // lines of the same sentence on every single run, which is how a warning
    // becomes wallpaper. It lives in the strip's tooltip now, where it is read
    // by someone who has already noticed the unchecked badge.
    summary: "One reader only — nothing cross-checked it" + (why ? ` (${why}).` : "."),
  };
}

// ------------------------------------------------------------- markdown

/** Who read the picture, and whether they agreed. */
export interface ReadingProvenance {
  /** Human labels of the models that produced the reading. */
  readers: string[];
  /** Null when only one reader answered, so there was nothing to cross-check. */
  agreement: ExtractionAgreement | null;
  /** Original independent readings, when available, for task-level cross checks. */
  independentReadings?: Extraction[];
  /** The image manifest, so the document says what it is a reading *of*. */
  manifest?: string;
  /** ISO timestamp, passed in rather than taken, so the output is testable. */
  at?: string;
}

/**
 * The reading as a document, rather than as a prompt fragment.
 *
 * `renderForReasoning` produces terse ALL-CAPS sections tuned for a model's
 * context window. This produces the same facts as Markdown a person can open,
 * read, diff and keep -- and which every model in the panel can also consume,
 * because Markdown is the one format none of them have to be taught.
 *
 * That second property is the point. A screenshot only reaches a model whose
 * route carries images, and this project has now watched two routes fail to
 * carry one. A picture is a capability; text is not. Converting the picture into
 * a document at the moment it arrives means the panel never depends on that
 * capability again -- every pane, seeing or blind, works from the same words.
 *
 * What must survive the conversion is the doubt. A transcription that quietly
 * drops "I could not tell a 1 from an l here" is more dangerous than the picture
 * it replaced, because it reads as certain. So ambiguities, conflicts between
 * the two readers, and the confidence figure are not footnotes here -- they are
 * sections, and they come before the code rather than after it.
 */
export function readingMarkdown(e: Extraction, p: ReadingProvenance): string {
  const out: string[] = [];
  const conflicts = p.agreement?.conflicts ?? [];
  const high = conflicts.filter((c) => c.severity === "high");

  out.push("# Screenshot reading");
  out.push(
    "> Machine-generated transcription of one or more screenshots. It is evidence " +
      "about a picture, not the picture. Where this document says it is unsure, it " +
      "is unsure — say so in your answer rather than choosing silently."
  );

  // --- provenance, first, because it sets how much weight the rest carries.
  const meta: string[] = [];
  if (p.at) meta.push(`- **Read at:** ${p.at}`);
  meta.push(
    p.readers.length
      ? `- **Read by:** ${p.readers.join(" and ")}${p.readers.length < 2 ? " (single reader — no cross-check)" : ""}`
      : "- **Read by:** unknown"
  );
  meta.push(`- **Confidence:** ${e.confidence.toFixed(2)} (the reader's trust in its own transcription)`);
  if (p.agreement) {
    meta.push(
      `- **Readers agreed:** ${p.agreement.agree ? "yes, on everything that matters" : `no — ${high.length} difference${high.length === 1 ? "" : "s"} that could change the answer`}`
    );
  }
  meta.push(`- **Kind:** ${e.kind}`);
  out.push(meta.join("\n"));

  if (p.manifest) out.push(`## What was captured\n\n${p.manifest}`);

  // The document is passed unchanged to the working Council models.
  // Routing advice therefore reaches the actual solving path, not just tests.
  const routing = reconcileProblemReadings(p.independentReadings?.length
    ? p.independentReadings : [e]);
  const unverifiedVisual = routing.path !== "standard" || (p.agreement && !p.agreement.agree);
  out.push("## Problem understanding and verification plan\\n\\n" +
    routingGuidance(routing) +
    (routing.disagreements.length
      ? "\\n\\nReader disagreements requiring source-image review:\\n" +
        routing.disagreements.map((d) => "- " + d).join("\\n")
      : "") +
    (unverifiedVisual
      ? "\\n\\nDo not claim this interpretation has been visually verified. Recheck the source image or clearly report the uncertainty."
      : ""));


  // --- the doubt, before the content it applies to.
  if (high.length) {
    out.push(
      "## ⚠ The two readers disagreed\n\n" +
        "Each line is a field where the readings differ in a way that could change " +
        "the answer. The merged value below is the more confident reader's. If your " +
        "answer depends on one of these, say which reading you took.\n\n" +
        high
          .map((c) => `- **${c.field}** — reader A: \`${oneLine(c.a)}\` · reader B: \`${oneLine(c.b)}\``)
          .join("\n")
    );
  }

  if (e.ambiguities.length) {
    out.push(
      "## ⚠ Characters the reader could not be sure of\n\n" +
        "Ambiguity here is real ambiguity in the source image — `l`/`1`/`I`, `O`/`0`, " +
        "`rn`/`m`. Do not resolve one silently; if it matters, state the reading you " +
        "chose and why.\n\n" +
        e.ambiguities.map((a) => `- ${a}`).join("\n")
    );
  }

  // --- the content itself.
  if (e.problemSummary) out.push(`## The problem\n\n${e.problemSummary}`);

  const facts: string[] = [];
  if (e.language) facts.push(`| Language | ${e.language} |`);
  if (e.framework) facts.push(`| Framework | ${e.framework} |`);
  if (e.filePath || e.fileName) facts.push(`| File | \`${e.filePath || e.fileName}\` |`);
  if (e.url) facts.push(`| URL | ${e.url} |`);
  if (facts.length) {
    out.push(`## Context\n\n| | |\n|---|---|\n${facts.join("\n")}`);
  }

  if (e.code) {
    out.push(
      `## Code, transcribed verbatim\n\n` +
        "Including any bug it contains. This is what was on the screen, not what it " +
        "should have said.\n\n" +
        fence(e.code, e.language)
    );
  }

  if (e.errors.length) {
    out.push(
      "## Errors on screen\n\n" +
        e.errors
          .map((x) => {
            const where = x.file ? ` — \`${x.file}${x.line ? `:${x.line}` : ""}\`` : "";
            return `- ${x.message}${where}`;
          })
          .join("\n")
    );
  }

  if (e.terminalCommands.length) {
    out.push(`## Commands run\n\n${fence(e.terminalCommands.join("\n"), "bash")}`);
  }
  if (e.terminalOutput) {
    out.push(`## Terminal output\n\n${fence(e.terminalOutput, "text")}`);
  }
  if (e.observations.length) {
    out.push("## Other notes\n\n" + e.observations.map((o) => `- ${o}`).join("\n"));
  }

  const low = conflicts.filter((c) => c.severity === "low");
  if (low.length) {
    out.push(
      "## Minor differences between the readers\n\n" +
        "These do not change the answer, and are recorded only so the reading can be " +
        "audited later.\n\n" +
        low.map((c) => `- **${c.field}** — \`${oneLine(c.a)}\` vs \`${oneLine(c.b)}\``).join("\n")
    );
  }

  if (!e.problemSummary && !e.code && !e.errors.length && !e.terminalOutput) {
    out.push(
      "## Nothing legible was found\n\n" +
        "The reading pass ran but came back with no problem statement, no code, no " +
        "error and no terminal output. Treat this document as empty: say that you " +
        "cannot see the problem rather than inferring one."
    );
  }

  return out.join("\n\n") + "\n";
}

/** Collapses a value to one line so a table row cannot break the document. */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? flat.slice(0, 77) + "…" : flat || "(empty)";
}

/**
 * Fences code without the fence being closed early by the code.
 *
 * Transcribed screenshots contain Markdown often enough -- a README, a chat log,
 * another fenced block -- and three backticks inside a three-backtick fence ends
 * it, silently turning the rest of the transcription into prose. Counting the
 * longest run present and going one longer is what CommonMark allows for exactly
 * this.
 */
function fence(body: string, lang = ""): string {
  const longest = (body.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

// ------------------------------------------------------------------- ocr

/**
 * Structuring a transcription is a different job from reading a picture.
 *
 * The model is no longer being asked to see. Cloud Vision has already turned the
 * pixels into characters, and done it better than a reasoning model would; what
 * is left is the part Vision cannot do at all — deciding what the screen *is*,
 * which language it is in, which line the error is on, and what is actually
 * being asked. That is a text task, which is why it costs a text request rather
 * than a vision one.
 *
 * The instruction that matters most is the one about invention. A model handed a
 * transcription with a gap in it will fill the gap, fluently, and nothing
 * downstream will be able to tell which parts were on screen and which were
 * supplied. Vision's own confidence scores are attached precisely so that the
 * doubt travels with the text instead of being smoothed away.
 */
export const OCR_STRUCTURE_SYSTEM = `
You are given a transcription of one or more screenshots, produced by an OCR
engine. You are not being shown the pictures, and you are not solving anything —
another model will do that from what you produce.

Your job is to say what this screen IS. The transcription already has the
characters right; what it has no idea about is meaning. Decide the kind of screen,
the language and framework, which lines are code and which are terminal output,
what the error is, and above all what is being asked.

Three rules, in order of how much damage breaking them does:

1. Never invent. If the transcription does not contain a file name, a URL or a
   framework, leave it empty. A plausible guess is worse than a blank, because
   everything downstream will treat your output as fact and no one will be able
   to tell which parts came off the screen.
2. Transcribe the code as given, bug included. You are not fixing it. If a line
   looks wrong, that is very likely the problem being asked about.
3. Carry the doubt forward. Any uncertainty listed in the transcription belongs
   in "ambiguities", along with anything you found genuinely unreadable.

Reply with one JSON object and nothing else, in exactly this shape:

{
  "kind": "code" | "terminal" | "browser" | "math" | "mixed" | "other",
  "language": "",
  "framework": "",
  "fileName": "",
  "filePath": "",
  "code": "",
  "errors": [{ "message": "", "file": "", "line": 0 }],
  "terminalCommands": [],
  "terminalOutput": "",
  "url": "",
  "observations": [],
  "problemSummary": "",
  "ambiguities": [],
  "confidence": 0.0
}

"confidence" is how much you trust your reading of what this screen is — not how
solvable the problem looks, and not the OCR engine's confidence, which you have
already been given.`.trim();

/** One screenshot as the OCR engine returned it. */
export interface OcrReading {
  text: string;
  unsure: string[];
  confidence: number;
  words: number;
}

/**
 * Below this many words, OCR has not found a screen full of text.
 *
 * A diagram, a chart or a UI mockup comes back with a scattering of labels, and
 * handing eleven disconnected words to a model as "the problem" is worse than
 * admitting the transcriber was the wrong tool. That case falls back to a vision
 * model, which is the only thing that can read a picture that is not text.
 */
export const MIN_OCR_WORDS = 12;

/** Whether the transcription is worth building a reading on. */
export function ocrIsUsable(pages: OcrReading[]): boolean {
  return pages.reduce((n, p) => n + p.words, 0) >= MIN_OCR_WORDS;
}

/**
 * The transcription as the structuring model is asked to read it.
 *
 * Numbered when there are several, because the screenshots are one problem in an
 * order and a model given four unlabelled blocks will treat them as four
 * problems. The engine's own uncertainty rides along with each page rather than
 * being pooled at the end — which character was doubtful matters much less than
 * *where* it was.
 */
export function ocrUserPrompt(pages: OcrReading[], note = ""): string {
  const parts: string[] = [];
  const many = pages.length > 1;

  pages.forEach((p, i) => {
    const head = many ? `--- SCREENSHOT ${i + 1} OF ${pages.length} ---` : "--- TRANSCRIPTION ---";
    const body = p.text.trim() || "(nothing legible)";
    const block = [head, body];
    if (p.unsure.length) {
      block.push(
        `--- THE ENGINE WAS UNSURE OF THESE ---\n${p.unsure.map((u) => `- ${u}`).join("\n")}`
      );
    }
    parts.push(block.join("\n"));
  });

  if (many) {
    parts.push(
      "These are one problem, in the order they were captured. A later screenshot may " +
        "continue or correct an earlier one."
    );
  }
  if (note.trim()) parts.push(`The person added this context: ${note.trim()}`);
  parts.push("Return the JSON object.");
  return parts.join("\n\n");
}

/**
 * Builds a reading from the transcription alone, when no model structured it.
 *
 * This is the path where the gateway budget is spent, every pane can see, or
 * there is simply no reason to pay for structuring. It produces a document that
 * is honest about what it is: the literal contents of the screen, correctly laid
 * out, with the engine's doubts attached — and no claim about what any of it
 * means, because nothing has looked at it yet.
 */
export function extractionFromOcr(pages: OcrReading[]): Extraction {
  const text = pages
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const unsure = Array.from(new Set(pages.flatMap((p) => p.unsure)));
  const scored = pages.filter((p) => p.words > 0);
  const confidence = scored.length
    ? scored.reduce((n, p) => n + p.confidence, 0) / scored.length
    : 0;

  return {
    ...EMPTY_EXTRACTION,
    kind: "other",
    // Deliberately in `code` rather than `problemSummary`: it is a verbatim
    // transcription, and calling it a summary would be a claim that something
    // read and condensed it.
    code: text,
    ambiguities: unsure,
    confidence,
  };
}

/**
 * Folds the engine's measured doubt into a model's structured reading.
 *
 * The uncertainty section of the document used to be filled by asking a model to
 * admit it was unsure, which is the one thing models are reliably bad at. These
 * are numbers from the transcriber, and they go in first for that reason.
 */
export function withOcrDoubt(e: Extraction, pages: OcrReading[]): Extraction {
  const measured = pages.flatMap((p) => p.unsure);
  if (!measured.length) return e;
  return {
    ...e,
    ambiguities: Array.from(new Set([...measured, ...e.ambiguities])),
  };
}
