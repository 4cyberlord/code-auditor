import type { ProblemFamily } from "./problemRouting.ts";
import type { ModelCapability } from "./adaptiveModelRouting.ts";

/** Audited, independent test outcomes only. Never accept an AI vote as truth. */
export interface VerifiedModelOutcome {
  model: string;
  family: ProblemFamily;
  correct: boolean;
  verified: boolean;
  /** Unique independently validated problem/test fixture ID. */
  evaluationId: string;
  /** Gateway/model-specific observed latency, when available. */
  latencyMs?: number;
}

export function summarizeVerifiedOutcomes(
  records: readonly VerifiedModelOutcome[],
  minimumSamples = 20,
): ModelCapability[] {
  const groups = new Map<string, Map<ProblemFamily, { correct: number; total: number; latency: number[] }>>();
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.verified || !record.model?.trim() || !record.evaluationId?.trim()) continue;
    const key = JSON.stringify([record.model, record.family, record.evaluationId]);
    if (ids.has(key)) continue; // Retries must not inflate evidence.
    ids.add(key);
    let perFamily = groups.get(record.model);
    if (!perFamily) { perFamily = new Map(); groups.set(record.model, perFamily); }
    const entry = perFamily.get(record.family) ?? { correct: 0, total: 0, latency: [] };
    entry.total++;
    if (record.correct) entry.correct++;
    if (typeof record.latencyMs === "number" && Number.isFinite(record.latencyMs) && record.latencyMs >= 0)
      entry.latency.push(record.latencyMs);
    perFamily.set(record.family, entry);
  }
  return [...groups].map(([id, families]) => {
    const trusted = [...families].filter(([, v]) => v.total >= minimumSamples);
    const total = trusted.reduce((n, [, v]) => n + v.total, 0);
    const correct = trusted.reduce((n, [, v]) => n + v.correct, 0);
    const times = trusted.flatMap(([, v]) => v.latency);
    return {
      id,
      families: trusted.filter(([, v]) => v.correct / v.total >= 0.7).map(([family]) => family),
      ...(total > 0 ? { verifiedAccuracy: correct / total, evaluatedSamples: total } : {}),
      ...(times.length ? { latencyMs: times.reduce((a, b) => a + b, 0) / times.length } : {}),
    };
  });
}
