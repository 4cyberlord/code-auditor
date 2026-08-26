/** Extracts the FINAL block each agent is contracted to emit. */

export interface AgentFinal {
  kind: "code" | "research" | "unknown";
  language: string;
  answer: string;
  complexity: string;
  confidence: number | null;
  claims: string[];
  code: string;
  /** The raw FINAL block, for the judge pass. */
  raw: string;
  /** False when we had to reconstruct it from an unstructured reply. */
  wellFormed: boolean;
}

const BLOCK = /<<<FINAL\s*([\s\S]*?)\s*FINAL>>>/i;
const FENCE = /```[a-zA-Z0-9+#._-]*\s*\n([\s\S]*?)```/g;

export function parseFinal(text: string): AgentFinal | null {
  if (!text.trim()) return null;

  const match = text.match(BLOCK);
  // A stream cut mid-block still has a usable head; take from the marker on.
  const body = match ? match[1] : sliceOpenBlock(text);

  if (body === null) return salvage(text);

  const field = (name: string) => {
    const re = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "im");
    const m = body.match(re);
    return m ? m[1].trim() : "";
  };

  const kindRaw = field("KIND").toLowerCase();
  const kind: AgentFinal["kind"] =
    kindRaw.includes("code") ? "code" : kindRaw.includes("research") ? "research" : "unknown";

  const confRaw = field("CONFIDENCE").replace(/[^0-9.]/g, "");
  const confNum = confRaw ? Number(confRaw) : NaN;

  return {
    kind,
    language: stripNa(field("LANGUAGE")),
    answer: stripNa(field("ANSWER")),
    complexity: stripNa(field("COMPLEXITY")),
    confidence: Number.isFinite(confNum) ? clamp01(confNum > 1 ? confNum / 100 : confNum) : null,
    claims: parseClaims(body),
    code: lastFence(body),
    raw: (match ? match[0] : body).trim(),
    wellFormed: Boolean(match),
  };
}

/** The model started a FINAL block but the stream ended before FINAL>>>. */
function sliceOpenBlock(text: string): string | null {
  const i = text.search(/<<<FINAL/i);
  return i === -1 ? null : text.slice(i + "<<<FINAL".length);
}

/** No FINAL block at all — rebuild something comparable from the reply itself. */
function salvage(text: string): AgentFinal {
  const code = lastFence(text);
  const prose = text.replace(FENCE, " ").trim();
  const sentences = splitSentences(prose).filter((s) => s.trim().length > 25);
  return {
    kind: code ? "code" : "unknown",
    language: "",
    answer: (sentences.at(-1) ?? prose.slice(0, 300)).trim(),
    complexity: "",
    confidence: null,
    claims: sentences.slice(-4).map((s) => s.trim()),
    code,
    raw: text.slice(-2000).trim(),
    wellFormed: false,
  };
}

function parseClaims(body: string): string[] {
  const start = body.search(/^\s*CLAIMS\s*:/im);
  if (start === -1) return [];
  const after = body.slice(start).split("\n").slice(1);
  const out: string[] = [];
  for (const line of after) {
    if (/^\s*(CODE|CONFIDENCE|COMPLEXITY|ANSWER|KIND|LANGUAGE)\s*:/i.test(line)) break;
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
    else if (out.length && line.trim() && !line.startsWith("```")) out[out.length - 1] += " " + line.trim();
  }
  return out.slice(0, 8);
}

function lastFence(text: string): string {
  const blocks = [...text.matchAll(FENCE)].map((m) => m[1]);
  if (!blocks.length) return "";
  // Prefer the longest fence: agents often show a tiny example before the solution.
  return blocks.reduce((a, b) => (b.trim().length > a.trim().length ? b : a)).trim();
}

/** Sentence split without lookbehind, which WebKit lacked before Safari 16.4. */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (".!?".includes(text[i])) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j > i + 1 || j === text.length) {
        out.push(text.slice(start, i + 1));
        start = j;
        i = j - 1;
      }
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

const stripNa = (s: string) => (/^(n\/?a|none|-{1,3})$/i.test(s.trim()) ? "" : s.trim());
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
