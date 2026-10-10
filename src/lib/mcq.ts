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


const OPTION_LINE = /^\s*(?:[-*]\s*)?(?:[\(\[]?([A-Ha-h]|[1-9][0-9]?)[\)\].:-])\s*(\S.*?)\s*$/;
const QUESTION_START = /^\s*(?:Q(?:uestion)?\s*\d+\s*[.)\]:-]?|\d+\s*[.)]\s+(?=[A-Z]))/i;

export function detectMcq(text: string): McqDetection {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const options: McqOption[] = [];
  const seen = new Set<string>();
  let start = -1;
  let current: McqOption | null = null;
  let family: "letter" | "number" | null = null;
  for (let i=0;i<lines.length;i++) {
    const line=lines[i];
    const match=OPTION_LINE.exec(line);
    const question=QUESTION_START.test(line) && (line.includes("?") || /^\s*Q/i.test(line));
    if(match && !question) {
      const label=match[1].toUpperCase();
      const next=/^[A-H]$/.test(label)?"letter":"number";
      if((family && family!==next)||seen.has(label)){current=null;continue;}
      if(start<0) start=i;
      family=next;
      current={label,text:match[2].trim()};
      options.push(current);seen.add(label);
    } else if(current && line.trim() && !QUESTION_START.test(line)) {
      current.text+=" "+line.trim();
    } else if(!line.trim() || question) current=null;
  }
  const question=(start<0?source:lines.slice(0,start).join("\n")).replace(/\s+/g," ").trim();
  const cue=/\b(which|what|choose|select|correct|incorrect|except|following|answer|true|false|best)\b/i.test(question)||question.includes("?");
  const coding=/`{3}|\b(write|implement|function|class|def|input|output|constraints?)\b/i.test(question);
  const confidence=Math.max(0,Math.min(1,(options.length>=2?.55:0)+(options.length>=3?.2:0)+(cue?.2:0)-(coding?.2:0)));
  return {isMcq:options.length>=2&&confidence>=.7,confidence,question,options};
}

/** Source-provenance validation; model-generated choices cannot overwrite captured options. */
export function resolveMcqSelection(answer: McqAnswer, detected: McqDetection): McqAnswer | null {
  if(!detected.isMcq||!detected.options.length)return null;
  const label=answer.answer.label.trim().toUpperCase();
  const match=detected.options.find(x=>x.label===label);
  const norm=(x:string)=>x.trim().replace(/\s+/g," ").toLowerCase();
  const text=answer.answer.text.trim();
  const textMatch=text&&norm(text)!==norm(label)?detected.options.filter(x=>norm(x.text)===norm(text)):[];
  if(match&&textMatch.length&&match.label!==textMatch[0].label)return null;
  const chosen=match??(textMatch.length===1?textMatch[0]:null);
  return chosen?{...answer,question:detected.question,options:detected.options,answer:chosen}:null;
}
export function formatMcqSelection(answer:McqAnswer):string {
  const index=answer.options.findIndex(x=>x.label===answer.answer.label);
  if(index<0)return "Answer needs verification";
  const n=index+1;
  const suffix=n%100>=11&&n%100<=13?"th":n%10===1?"st":n%10===2?"nd":n%10===3?"rd":"th";
  return "✅ "+answer.answer.label+" ("+n+suffix+" Option) - "+answer.answer.text;
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
