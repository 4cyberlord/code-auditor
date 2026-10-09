import type { ModelCapability } from "./adaptiveModelRouting.ts";
import { summarizeVerifiedOutcomes } from "./verifiedModelAnalytics.ts";
import { verifySignedBenchmarkReport, type SignedBenchmarkReport } from "./signedBenchmark.ts";

/**
 * The ONLY approved conversion from externally signed benchmark evidence into
 * adaptive capability scores. Caller must supply an independently pinned key.
 * Unverified reports fail closed and cannot contribute metrics.
 */
export async function capabilitiesFromSignedBenchmark(
  report: SignedBenchmarkReport,
  pinnedPublicKey: CryptoKey | null,
): Promise<ModelCapability[] | null> {
  const outcomes = await verifySignedBenchmarkReport(report, pinnedPublicKey);
  if (!outcomes) return null;
  return summarizeVerifiedOutcomes(outcomes).filter(
    item => item.evaluatedSamples !== undefined && item.evaluatedSamples >= 20,
  );
}

/**
 * Apply only authenticated performance metrics to the configured catalogue.
 * Never promote signed claims of vision, availability, endpoints or prices.
 */
export function attachSignedBenchmarkMetrics(
  capabilities: readonly ModelCapability[],
  verified: readonly ModelCapability[],
): ModelCapability[] {
  const byId = new Map(verified.filter(item =>
    typeof item.verifiedAccuracy === "number" &&
    Number.isFinite(item.verifiedAccuracy) &&
    item.verifiedAccuracy >= 0 && item.verifiedAccuracy <= 1 &&
    typeof item.evaluatedSamples === "number" && item.evaluatedSamples >= 20,
  ).map(item => [item.id, item]));
  return capabilities.map(cap => {
    const report = byId.get(cap.id);
    if (!report) return { ...cap, families: undefined, verifiedAccuracy: undefined, evaluatedSamples: undefined };
    return { ...cap, families: report.families, verifiedAccuracy: report.verifiedAccuracy, evaluatedSamples: report.evaluatedSamples };
  });
}
