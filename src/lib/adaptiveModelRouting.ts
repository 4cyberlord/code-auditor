import type { ProblemRouting, ProblemFamily } from "./problemRouting.ts";

/**
 * Phase 6.6: deterministic routing of *configured* models only.
 * No unverified model capabilities are fabricated. Callers can supply measured
 * metrics and capability attestations from their configured catalogue.
 */
export interface ModelCapability {
  id: string;
  families?: readonly ProblemFamily[];
  vision?: boolean;
  verifiedVisual?: boolean;
  availability?: "available" | "unavailable" | "unknown";
  verifiedAccuracy?: number; // 0..1, only from adjudicated runs
  evaluatedSamples?: number;
  latencyMs?: number;
  costPerMillion?: number;
}
export interface RoutingDecision<T> {
  selected: T[];
  excluded: { id: string; reason: string }[];
  explanation: string[];
}
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const relevant = (route: ProblemRouting, c: ModelCapability) =>
  route.families.some(f => f !== "other" && c.families?.includes(f));
function score(route: ProblemRouting, c: ModelCapability): number {
  const reliability = valid(c.verifiedAccuracy) && (c.evaluatedSamples ?? 0) >= 20
    ? clamp(c.verifiedAccuracy) * 30 : 0;
  const expertise = relevant(route, c) ? 40 : 0;
  const visual = route.needsVisualStructure && c.verifiedVisual ? 10 : 0;
  const latency = valid(c.latencyMs) && c.latencyMs! >= 0 ? 5 / (1 + c.latencyMs! / 10000) : 0;
  const cost = valid(c.costPerMillion) && c.costPerMillion! >= 0 ? 3 / (1 + c.costPerMillion!) : 0;
  return expertise + reliability + visual + latency + cost;
}
/**
 * Images in the problem do NOT imply that every solver needs images: when the
 * extraction contract is verified, text-only models remain eligible. A model
 * that actually receives image bytes must have independently attested vision.
 */
export function selectAdaptiveModels<T>(
  configured: readonly T[],
  idOf: (item: T) => string,
  route: ProblemRouting,
  capabilities: readonly ModelCapability[],
  count: number,
  options: { passesImages?: boolean; excludedIds?: readonly string[] } = {},
): RoutingDecision<T> {
  const byId = new Map(capabilities.map(c => [c.id, c]));
  const excluded: RoutingDecision<T>["excluded"] = [];
  const seen = new Set(options.excludedIds ?? []);
  const candidates: { item: T; index: number; rank: number }[] = [];
  configured.forEach((item, index) => {
    const id = idOf(item), cap = byId.get(id);
    if (!id || seen.has(id)) { excluded.push({ id, reason: "Duplicate or already seated" }); return; }
    seen.add(id);
    if (cap?.availability === "unavailable") {
      excluded.push({ id, reason: "Unavailable" }); return;
    }
    if (options.passesImages && cap?.vision !== true) {
      excluded.push({ id, reason: "Vision capability not verified" }); return;
    }
    candidates.push({ item, index, rank: cap ? score(route, cap) : 0 });
  });
  candidates.sort((a, b) => b.rank - a.rank || a.index - b.index);
  return {
    selected: candidates.slice(0, Math.max(0, count)).map(c => c.item),
    excluded,
    explanation: [
      "Only configured models are eligible; ties preserve configured order.",
      "Verified specialist accuracy requires at least 20 adjudicated examples.",
      options.passesImages ? "Models without explicitly verified vision are excluded." : "No image capability is required for text-only solver requests.",
    ],
  };
}
/** Specialists are judged by the same evidence rather than by a fixed vendor preference. */
export function selectAdaptiveJudges<T>(
  judges: readonly T[], modelOf: (judge:T)=>string, route: ProblemRouting,
  capabilities: readonly ModelCapability[], count: number,
): RoutingDecision<T> {
  return selectAdaptiveModels(judges, modelOf, route, capabilities, count);
}

/** Screenshot bytes can be omitted only after independent, consistent reading. */
export function verifiedTextOnlyScreenshot(
  hasImages: boolean,
  readers: readonly { confidence: number; ambiguities: readonly string[] }[],
  merged: { confidence: number } | null | undefined,
  route: ProblemRouting,
  contractDifferences: readonly string[] = [],
): boolean {
  return hasImages && readers.length >= 2
    && readers.every(r => Number.isFinite(r.confidence) && r.confidence >= 0.85 && r.ambiguities.length === 0)
    && merged != null && Number.isFinite(merged.confidence) && merged.confidence >= 0.85
    && route.path === "standard" && contractDifferences.length === 0;
}
