/**
 * Consensus engine.
 *
 * The honest framing: this measures *agreement*, not correctness. Four models can
 * agree and all be wrong, so the UI says "agreed", never "verified", and the judge
 * pass exists for when agreement isn't enough.
 *
 * Comparison runs on three axes so that two solutions written in different styles
 * still cluster: the answer sentence, the supporting claims, and the code structure.
 */

import type { AgentFinal } from "./parse.ts";
import { normalizeCodeLanguage } from "./council.ts";

export type Verdict = "unanimous" | "majority" | "split" | "none" | "insufficient";

export interface PairScore {
  a: string;
  b: string;
  score: number;
  answer: number;
  claims: number;
  code: number;
}

export interface ConsensusResult {
  verdict: Verdict;
  headline: string;
  detail: string;
  /** Agent ids grouped by mutual agreement, largest group first. */
  groups: string[][];
  pairs: PairScore[];
  /** The agent whose answer best represents the largest group. */
  representative: string | null;
  agreementRatio: number;
  outliers: string[];
  /**
   * How much the lexical verdict is worth. "high" when every pair was compared on
   * actual code; "low" when it is prose only, where two answers can mean the same
   * thing while sharing almost no words.
   */
  reliability: "high" | "mixed" | "low";
  /** Set when the verdict should not be taken at face value. */
  advisory: string | null;
}

export interface ConsensusInput {
  id: string;
  name: string;
  final: AgentFinal;
}

// ------------------------------------------------------------------ similarity

const STOP = new Set(
  ("the a an and or of to in is are be it this that for on with as by we you i not no if then " +
    "will can may must should would could there here so such than into from at its").split(" ")
);

/**
 * Tokens that carry algorithmic meaning across languages. Everything else in a
 * program is treated as a renameable identifier, which is what lets two correct
 * solutions match even when one calls it `seen` and the other calls it `d`.
 */
const CODE_KEYWORDS = new Set(
  ("if else elif for while do return def function fn func class struct impl interface enum " +
    "import from export let const var static public private protected new delete try catch except " +
    "finally throw raise break continue pass yield lambda async await match case switch default " +
    "in not and or is none null nil true false self this super typeof instanceof " +
    "int float double long short char bool boolean string str list dict set tuple map array vec " +
    "len range enumerate zip sorted sort reverse reversed append push pop shift unshift insert " +
    "keys values items get put has contains index find filter reduce min max sum abs round " +
    "print println console log printf format join split strip trim replace slice substring " +
    "while_let unwrap some ok err option result").split(" ")
);

/**
 * A crude suffix stripper, not a real Porter stemmer.
 *
 * The job here is only to make paraphrase match: "applies"/"apply",
 * "effective"/"effect", "newly"/"new". Over-stemming costs far less than the
 * false disagreements we get without it.
 */
function stem(w: string): string {
  if (w.length <= 4) return w;
  for (const suf of ["ations", "ation", "ively", "ingly", "ically", "ement", "ments", "ness", "ing", "edly", "ely", "ive", "ally", "ily", "ies", "ied", "ment", "ers", "est", "ed", "ly", "es", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      let base = w.slice(0, w.length - suf.length);
      if (suf === "ies" || suf === "ied") base += "i";
      // Undo the doubled consonant in "stopping" -> "stop".
      if (/([bdfglmnprt])\1$/.test(base)) base = base.slice(0, -1);
      return base;
    }
  }
  return w;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+\-*/<>=%.\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

function bigrams(tokens: string[]): Set<string> {
  if (tokens.length < 2) return new Set(tokens);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) out.add(tokens[i] + " " + tokens[i + 1]);
  return out;
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/** Sorensen-Dice: symmetric, penalises length mismatch. */
function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  return (2 * shared(a, b)) / (a.size + b.size);
}

/** Overlap coefficient: forgives a terse answer next to a verbose one. */
function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  return shared(a, b) / Math.min(a.size, b.size);
}

/**
 * Raw lexical overlap sits low even for answers a human would call identical, so
 * the blend is pulled through a gentle curve. That widens the gap between "same
 * idea, different words" and "different idea" where the threshold has to live.
 */
function curve(x: number): number {
  return Math.pow(Math.max(0, Math.min(1, x)), 0.6);
}

function textSim(a: string, b: string): number {
  if (!a.trim() && !b.trim()) return 1;
  if (!a.trim() || !b.trim()) return 0;
  const ta = words(a);
  const tb = words(b);
  const ua = new Set(ta);
  const ub = new Set(tb);
  const raw =
    0.3 * dice(bigrams(ta), bigrams(tb)) + 0.4 * dice(ua, ub) + 0.3 * containment(ua, ub);
  return curve(raw);
}

/** Comments, string contents and layout carry no algorithmic weight. */
function normalizeCode(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)(\/\/|#).*$/gm, "$1")
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function codeTokens(code: string): string[] {
  return normalizeCode(code).match(/[a-z_][a-z0-9_]*|[0-9]+(?:\.[0-9]+)?|[^\sa-z0-9_]/g) ?? [];
}

/** Replace user-chosen names with a placeholder, keeping control flow intact. */
function maskIdentifiers(tokens: string[]): string[] {
  return tokens.map((t) =>
    /^[a-z_][a-z0-9_]*$/.test(t) && !CODE_KEYWORDS.has(t) ? "$id" : t
  );
}

function codeSim(a: string, b: string, langA = "", langB = ""): number {
  const hasA = a.trim().length > 0;
  const hasB = b.trim().length > 0;
  if (!hasA && !hasB) return -1; // axis not applicable to this pair
  if (!hasA || !hasB) return 0; // one produced code, the other didn't: real disagreement

  // Two languages cannot be compared lexically, and pretending otherwise is how
  // four agents that all wrote the same two-pointer scan got reported as "every
  // agent produced a materially different answer". `for i in range(n):` and
  // `for (int i = 0; i < n; ++i)` share almost no structure, and this axis
  // carries 0.7 of the weight — so identical thinking in different languages
  // scored as total disagreement.
  //
  // The honest answer is that the axis does not apply, exactly as it does not
  // apply when only one of them wrote code at all. Dropping it hands the
  // decision to the answer and the claims, which *are* comparable across
  // languages and are where the agreement actually lives.
  const la = normalizeCodeLanguage(langA);
  const lb = normalizeCodeLanguage(langB);
  if (la && lb && la !== lb) return -1;

  if (normalizeCode(a) === normalizeCode(b)) return 1;

  const ta = codeTokens(a);
  const tb = codeTokens(b);

  // Structure with names erased is the honest signal; raw tokens are a tiebreak
  // that still rewards calling the same library function.
  const structural = dice(bigrams(maskIdentifiers(ta)), bigrams(maskIdentifiers(tb)));
  const literal = dice(bigrams(ta), bigrams(tb));
  return 0.7 * structural + 0.3 * literal;
}

function claimsSim(a: string[], b: string[]): number {
  if (!a.length && !b.length) return -1;
  if (!a.length || !b.length) return 0;
  // Each claim finds its best partner; average the matches both ways.
  const best = (from: string[], to: string[]) =>
    from.reduce((sum, c) => sum + Math.max(...to.map((d) => textSim(c, d))), 0) / from.length;
  return (best(a, b) + best(b, a)) / 2;
}

/**
 * Axis weights depend on what the pair actually produced. When both wrote code,
 * the code *is* the answer and the prose around it barely matters; for a research
 * question there is no code, so the claims carry the weight instead.
 */
function pairScore(x: ConsensusInput, y: ConsensusInput): PairScore {
  const answer = textSim(x.final.answer, y.final.answer);
  const claims = claimsSim(x.final.claims, y.final.claims);
  const code = codeSim(x.final.code, y.final.code, x.final.language, y.final.language);
  const bothCoded = code >= 0;

  const parts: [number, number][] = [[answer, bothCoded ? 0.1 : 0.45]];
  if (claims >= 0) parts.push([claims, bothCoded ? 0.2 : 0.55]);
  if (bothCoded) parts.push([code, 0.7]);

  const total = parts.reduce((s, [, w]) => s + w, 0);
  const blended = parts.reduce((s, [v, w]) => s + v * w, 0) / total;

  // Code comparison is a much sharper instrument than prose comparison: two
  // matching algorithms land near 0.85 while two matching paragraphs land near
  // 0.55. Lifting the prose-only regime puts both on one scale, so a single
  // threshold means the same thing whichever kind of problem was asked.
  const score = bothCoded ? blended : Math.pow(blended, 0.75);

  return { a: x.id, b: y.id, score, answer, claims, code };
}


// ------------------------------------------------------------------ clustering

export function computeConsensus(inputs: ConsensusInput[], threshold = 0.55): ConsensusResult {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError("Consensus threshold must be between 0 and 1.");
  }
  // IDs determine pair identity and grouping. Duplicates silently collapse
  // distinct agents into one group and can manufacture majority or unanimity.
  const ids = new Set<string>();
  for (const input of inputs) {
    if (typeof input.id !== "string" || !input.id.trim() || ids.has(input.id)) {
      throw new Error("Consensus inputs require unique, nonempty agent IDs.");
    }
    ids.add(input.id);
  }
  const usable = inputs.filter((i) => i.final && (i.final.answer.trim() || i.final.code.trim()));

  if (usable.length < 2) {
    return {
      verdict: "insufficient",
      headline: "Not enough answers to compare",
      detail:
        usable.length === 1
          ? "Only one agent returned an answer, so there is nothing to cross-check it against."
          : "No agent has returned a parseable answer yet.",
      groups: usable.map((u) => [u.id]),
      pairs: [],
      representative: usable[0]?.id ?? null,
      agreementRatio: 0,
      outliers: [],
      reliability: "low",
      advisory: null,
    };
  }

  const pairs: PairScore[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) pairs.push(pairScore(usable[i], usable[j]));
  }

  // Complete-link clustering: every pair of members within a consensus group
  // must actually agree. Connected-component chaining can report unanimity
  // even when the first and last candidates explicitly disagree.
  // Stable IDs make consensus independent of agent completion order.
  const sorted = [...usable].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const order = new Map(sorted.map((u, i) => [u.id, i]));
  const scoreFor = new Map<string, number>();
  for (const p of pairs) {
    scoreFor.set([p.a, p.b].sort().join("\\0"), p.score);
  }
  const agrees = (a: string, b: string) =>
    (scoreFor.get([a, b].sort().join("\\0")) ?? 0) >= threshold;
  const groups: string[][] = [];
  for (const item of sorted) {
    const candidateGroups = groups
      .filter((g) => g.every((member) => agrees(item.id, member)))
      .sort((a, b) => b.length - a.length || order.get(a[0])! - order.get(b[0])!);
    if (candidateGroups[0]) candidateGroups[0].push(item.id);
    else groups.push([item.id]);
  }
  groups.sort((a, b) => b.length - a.length || order.get(a[0])! - order.get(b[0])!);

  const largest = groups[0];
  const n = usable.length;
  const ratio = largest.length / n;

  let verdict: Verdict;
  if (largest.length === n) verdict = "unanimous";
  else if (largest.length > n / 2) verdict = "majority";
  else if (groups.length === 2 && groups[1].length === largest.length) verdict = "split";
  else verdict = "none";

  const name = (id: string) => usable.find((u) => u.id === id)?.name ?? id;
  const outliers = groups.slice(1).flat();

  const headline =
    verdict === "unanimous"
      ? `All ${n} agents agree`
      : verdict === "majority"
        ? `${largest.length} of ${n} agree`
        : verdict === "split"
          ? `Split ${largest.length}-${groups[1].length}`
          : `No consensus across ${n} agents`;

  const detail =
    verdict === "unanimous"
      ? "Every agent arrived at substantially the same answer. That is agreement, not proof: if the problem is subtle, spot-check it or run the judge."
      : verdict === "majority"
        ? `${outliers.map(name).join(" and ")} went a different way. A majority is not a guarantee, so read the outlier before dismissing it. The lone dissenter is sometimes the one that caught the edge case.`
        : verdict === "split"
          ? `The panel divided into two camps: ${groups.map((g) => g.map(name).join(" + ")).join(" vs ")}. This usually means the problem statement is ambiguous or the image was hard to read. Run the judge, or check the transcriptions.`
          : "Every agent produced a materially different answer. Check that the image is legible and the whole problem is in frame before trusting any single result.";

  // Representative = the member of the winning group that agrees most with the rest.
  const representative =
    largest
      .map((id) => ({
        id,
        affinity: pairs
          .filter(
            (p) => (p.a === id || p.b === id) && largest.includes(p.a) && largest.includes(p.b)
          )
          .reduce((s, p) => s + p.score, 0),
        conf: usable.find((u) => u.id === id)?.final.confidence ?? 0,
      }))
      .sort((x, y) => y.affinity - x.affinity || y.conf - x.conf)[0]?.id ?? null;

  const coded = pairs.filter((p) => p.code >= 0).length;
  const reliability: ConsensusResult["reliability"] =
    coded === pairs.length ? "high" : coded === 0 ? "low" : "mixed";

  const advisory =
    reliability === "low"
      ? "These answers were compared on wording alone, and two prose answers can mean the same thing while sharing barely a word. Treat this verdict as a hint and run the judge for a real comparison."
      : reliability === "mixed"
        ? "Some agents returned code and some did not, so the panel is being compared on uneven ground. The judge will give a cleaner read."
        : null;

  return {
    verdict,
    headline,
    detail,
    groups,
    pairs,
    representative,
    agreementRatio: ratio,
    outliers,
    reliability,
    advisory,
  };
}
