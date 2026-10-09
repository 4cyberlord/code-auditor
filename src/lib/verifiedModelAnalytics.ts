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

/**
 * Convert measured sandbox execution into an evaluation record, but only when
 * the harness is independently trusted. AI-generated suites from this council
 * are NOT trusted fixtures and must never call this without outside review.
 */
export function outcomeFromTrustedExecution(input: {
  model: string;
  family: ProblemFamily;
  evaluationId: string;
  independentlyVerifiedFixture: boolean;
  ran: boolean;
  ok: boolean;
  passed: number;
  failed: number;
  timedOut?: boolean;
  truncated?: boolean;
  durationMs?: number;
}): VerifiedModelOutcome | null {
  if (!input.independentlyVerifiedFixture || !input.model.trim() ||
      !input.evaluationId.trim() || !input.ran ||
      !Number.isSafeInteger(input.passed) || !Number.isSafeInteger(input.failed) ||
      input.passed < 0 || input.failed < 0 || input.passed + input.failed === 0 ||
      input.truncated) return null;
  return {
    model: input.model,
    family: input.family,
    evaluationId: input.evaluationId,
    verified: true,
    correct: input.ok && !input.timedOut && input.failed === 0 && input.passed > 0,
    ...(typeof input.durationMs === "number" && Number.isFinite(input.durationMs) &&
      input.durationMs >= 0 ? { latencyMs: input.durationMs } : {}),
  };
}

/** Idempotent, bounded history insertion. Repeat fixture results replace older results. */
export function mergeVerifiedOutcomes(
  current: readonly VerifiedModelOutcome[],
  incoming: readonly VerifiedModelOutcome[],
  limit = 2000,
): VerifiedModelOutcome[] {
  const records = new Map<string, VerifiedModelOutcome>();
  for (const item of [...current, ...incoming]) {
    if (!item.verified || !item.model?.trim() || !item.evaluationId?.trim()) continue;
    records.set(JSON.stringify([item.model, item.family, item.evaluationId]), item);
  }
  return [...records.values()].slice(-Math.max(0, Math.floor(limit)));
}
