import { attachSignedBenchmarkMetrics } from "./authenticatedBenchmarkRouting.ts";
import { loadAuthenticatedBenchmarkCapabilities } from "./benchmarkFeed.ts";
import { selectAdaptiveModels, type ModelCapability } from "./adaptiveModelRouting.ts";
import type { ProblemRouting } from "./problemRouting.ts";

/** Lightweight, deterministic panel planning. The signed benchmarks are the only
 * source of accuracy and task expertise; user-entered labels are not proof. */
export interface PanelCandidate<Id extends string = string> {
  id: Id;
  model: string;
  canSeeImages: boolean;
}
export interface ProbeObservation {
  ok: boolean;
  at: number;
  ms: number;
  vision?: boolean | null;
}
export interface PanelDecision<Id extends string = string> {
  selected: Id[];
  explanation: string[];
  excluded: { id: string; reason: string }[];
  requiredImageAccess: boolean;
  confidence: "verified" | "limited";
}
export function planIntelligentPanels<Id extends string>(input: {
  candidates: readonly PanelCandidate<Id>[];
  route: ProblemRouting;
  hasImages: boolean;
  safeTextOnly: boolean;
  trustedMetrics: readonly ModelCapability[];
  probes: Readonly<Record<string, ProbeObservation | undefined>>;
  maxPanels?: number;
  now?: number;
}): PanelDecision<Id> {
  const { route, hasImages, safeTextOnly, trustedMetrics, probes } = input;
  const rawImage = hasImages && !safeTextOnly;
  const now = input.now ?? Date.now();
  const candidates = input.candidates.filter(c => c.id && c.model);
  const evidence = candidates.map(c => {
    const probe = probes[c.model];
    // Vision probing and availability are route/model-specific. A stale or
    // failed probe is never promoted to verified screenshot access.
    const fresh = !!probe && Number.isFinite(probe.at) && probe.at <= now &&
      now - probe.at < 24 * 60 * 60 * 1000;
    const observed = fresh && probe?.ok ? probe : undefined;
    const signed = trustedMetrics.find(m => m.id === c.model);
    return {
      id: c.id,
      families: signed?.families,
      verifiedAccuracy: signed?.verifiedAccuracy,
      evaluatedSamples: signed?.evaluatedSamples,
      latencyMs: observed?.ms,
      vision: c.canSeeImages && observed?.vision === true,
      verifiedVisual: c.canSeeImages && observed?.vision === true,
      availability: fresh && probe?.ok === false ? "unavailable" as const : "unknown" as const,
    } satisfies ModelCapability;
  });
  const complex = route.families.some(f => ["graph", "tree", "dynamic_programming", "concurrency", "geometry", "backtracking"].includes(f));
  const unclear = route.path !== "standard" || route.families.includes("other");
  const desired = unclear || route.verification !== "exact_output" ? 4 : complex ? 3 : 2;
  const seats = Math.min(candidates.length, Math.max(1, input.maxPanels ?? 4), desired);
  const result = selectAdaptiveModels(candidates, c => c.id, route, evidence, seats, { passesImages: rawImage });
  const signedEvidence = result.selected.some(c =>
    trustedMetrics.some(m => m.id === c.model && (m.evaluatedSamples ?? 0) >= 20));
  return {
    selected: result.selected.map(c => c.id),
    excluded: result.excluded,
    requiredImageAccess: rawImage,
    confidence: signedEvidence ? "verified" : "limited",
    explanation: [
      `Classified: ${route.families.join(", ")}. Reading: ${route.path}.`,
      `Target: ${seats} independent solver ${seats === 1 ? "panel" : "panels"}.`,
      signedEvidence
        ? "Selected using independently signed benchmark performance where available."
        : "Limited verified model-performance evidence; tie-breaks use configured order.",
      rawImage
        ? "Screenshots require a recent successful independent vision probe for the exact model."
        : "Cross-checked image reading permits text-only specialists.",
      ...result.explanation,
    ],
  };
}

/** Fetch only deployment-pinned, signature-verified empirical capabilities.
 * Missing configuration or a failed fetch yields no trusted accuracy claims. */
export async function loadTrustedPanelMetrics(): Promise<ModelCapability[]> {
  const endpoint = process.env.NEXT_PUBLIC_COUNCIL_BENCHMARK_FEED_URL ?? "";
  const rawKey = process.env.NEXT_PUBLIC_COUNCIL_BENCHMARK_P256_JWK ?? "";
  if (!endpoint || !rawKey) return [];
  try {
    const jwk = JSON.parse(rawKey) as JsonWebKey;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d !== undefined) return [];
    const key = await crypto.subtle.importKey("jwk", jwk,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const result = await loadAuthenticatedBenchmarkCapabilities(endpoint, key);
    // Refuse any unsigned performance evidence, including from local settings.
    return attachSignedBenchmarkMetrics(result ?? [], result ?? []);
  } catch {
    return [];
  }
}
