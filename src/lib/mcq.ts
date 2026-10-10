"use client";

export type OverlayMode = "auto" | "coding" | "mcq";
export type SolveJobMode = "council" | "mcq";
export type McqEndpoint = "auto" | "chat" | "responses";

export interface McqOption {
  label: string;
  text: string;
}

export interface McqWhyNot {
  label: string;
  reason: string;
}

export interface McqAnswer {
  kind: "mcq";
  question: string;
  options: McqOption[];
  answer: McqOption;
  reason: string;
  whyNot: McqWhyNot[];
  knowledgeUsed: boolean;
  model: string;
}

export interface McqDetection {
  isMcq: boolean;
  confidence: number;
  question: string;
  options: McqOption[];
}

const OPTION_LINE =
  /^\s*(?:[-*]\s*)?(?:[\(\[]?([A-Ha-h]|[1-9][0-9]?)[\)\].:-])\s+(.+?)\s*$/gm;

export function detectMcq(text: string): McqDetection {
  const source = String(text || "");
  const options: McqOption[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  OPTION_LINE.lastIndex = 0;
  while ((match = OPTION_LINE.exec(source))) {
    const label = match[1].toUpperCase();
    const body = match[2].trim();
    if (!body || seen.has(label)) continue;
    seen.add(label);
    options.push({ label, text: body });
  }

  const lower = source.toLowerCase();
  const questionCue =
    /\b(which|what|choose|select|correct|best|following|answer)\b/.test(lower) ||
    source.includes("?");
  const codingCue =
    /```|\b(write|implement|return|function|class|def|input|output|constraints?)\b/i.test(source);
  let confidence = 0;
  if (options.length >= 2) confidence += 0.55;
  if (options.length >= 3) confidence += 0.2;
  if (questionCue) confidence += 0.2;
  if (codingCue) confidence -= 0.2;
  confidence = Math.max(0, Math.min(1, confidence));

  const firstOptionIndex = options.length
    ? source.search(/^\s*(?:[\(\[]?[A-Ha-h1-9][0-9]?[\)\].:-])\s+/m)
    : -1;
  const question = (firstOptionIndex > 0 ? source.slice(0, firstOptionIndex) : source)
    .replace(/\s+/g, " ")
    .trim();

  return {
    isMcq: confidence >= 0.7 && options.length >= 2,
    confidence,
    question,
    options,
  };
}


/** Resolve model output against the question's independently extracted options. */
export function resolveMcqSelection(answer: McqAnswer, detected: McqDetection): McqAnswer | null {
  if (!detected.isMcq || !detected.options.length) return null;
  const label = answer.answer.label.trim().toUpperCase();
  const byLabel = detected.options.find(o => o.label === label);
  const rawText = answer.answer.text.trim();
  const norm = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  const byText = rawText && norm(rawText) !== norm(label)
    ? detected.options.filter(o => norm(o.text) === norm(rawText)) : [];
  if (byLabel && byText.length && byText[0].label !== byLabel.label) return null;
  const selected = byLabel ?? (byText.length === 1 ? byText[0] : null);
  if (!selected) return null;
  return { ...answer, question: detected.question, options: detected.options, answer: selected };
}

export function formatMcqSelection(answer: McqAnswer): string {
  const index = answer.options.findIndex(o => o.label === answer.answer.label);
  if (index < 0) return "Answer needs verification";
  const n = index + 1;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" :
    n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `✅ ${answer.answer.label} (${n}${suffix} Option) - ${answer.answer.text}`;
}

export function normalizeOverlayMode(value: unknown): OverlayMode {
  return value === "coding" || value === "mcq" || value === "auto" ? value : "auto";
}

export function normalizeMcqEndpoint(value: unknown): McqEndpoint {
  return value === "chat" || value === "responses" || value === "auto" ? value : "auto";
}

export function parseMcqAnswer(raw: string, fallback: Partial<McqAnswer> = {}): McqAnswer | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const answer = parsed.answer || {};
      return {
        kind: "mcq",
        question: String(parsed.question || fallback.question || "").trim(),
        options: Array.isArray(parsed.options) ? parsed.options.map(normalizeOption).filter(Boolean) : fallback.options || [],
        answer: normalizeOption(answer) || fallback.answer || { label: "", text: String(answer || "").trim() },
        reason: String(parsed.reason || fallback.reason || "").trim(),
        whyNot: Array.isArray(parsed.whyNot)
          ? parsed.whyNot.map((x: unknown) => ({
              label: String((x as { label?: unknown })?.label || "").trim(),
              reason: String((x as { reason?: unknown })?.reason || "").trim(),
            })).filter((x: McqWhyNot) => x.label || x.reason)
          : fallback.whyNot || [],
        knowledgeUsed: Boolean(parsed.knowledgeUsed ?? fallback.knowledgeUsed),
        model: String(parsed.model || fallback.model || "").trim(),
      };
    } catch {
      // Fall through to the plain-text parser.
    }
  }

  const label = text.match(/\b(?:answer|choice)\s*[:\-]\s*([A-H]|[1-9][0-9]?)\b/i)?.[1]?.toUpperCase() || "";
  return {
    kind: "mcq",
    question: String(fallback.question || "").trim(),
    options: fallback.options || [],
    answer: fallback.answer || { label, text: label },
    reason: text,
    whyNot: fallback.whyNot || [],
    knowledgeUsed: Boolean(fallback.knowledgeUsed),
    model: String(fallback.model || "").trim(),
  };
}

function normalizeOption(value: unknown): McqOption | null {
  if (!value || typeof value !== "object") return null;
  const option = value as { label?: unknown; text?: unknown };
  const label = String(option.label || "").trim().toUpperCase();
  const text = String(option.text || "").trim();
  return label || text ? { label, text } : null;
}
