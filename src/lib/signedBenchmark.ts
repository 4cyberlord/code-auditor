import type { VerifiedModelOutcome } from "./verifiedModelAnalytics.ts";

const ALLOWED_FAMILIES = new Set([
  "array", "string", "tree", "graph", "dynamic_programming", "linked_list",
  "heap", "math", "geometry", "database", "concurrency", "greedy",
  "backtracking", "other",
]);

export interface SignedBenchmarkReport {
  version: 1;
  /** Immutable canonical JSON serialized by the trusted producer. */
  payload: string;
  /** base64url-encoded ECDSA P-256 SHA-256 signature of UTF-8 payload bytes. */
  signature: string;
}

function base64UrlBytes(encoded: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const input = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const out: number[] = [];
    let buffer = 0, bits = 0;
    for (const ch of input) {
      const value = alphabet.indexOf(ch);
      if (value < 0) return null;
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buffer >>> bits) & 255); }
    }
    if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
    return new Uint8Array(out);
  } catch { return null; }
}

/**
 * Verify a benchmark report against a pinned public signing key, supplied by
 * application code or a secure deployment channel; NEVER from saved settings
 * or from the report itself. An absent key fails closed.
 */
export async function verifySignedBenchmarkReport(
  report: SignedBenchmarkReport,
  pinnedPublicKey: CryptoKey | null,
): Promise<VerifiedModelOutcome[] | null> {
  if (!pinnedPublicKey || report.version !== 1 ||
      typeof report.payload !== "string" || report.payload.length > 2_000_000 ||
      typeof report.signature !== "string") return null;
  const signature = base64UrlBytes(report.signature);
  if (!signature || signature.length !== 64) return null;
  try {
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, pinnedPublicKey,
      signature as BufferSource, new TextEncoder().encode(report.payload),
    );
    if (!valid) return null;
    const parsed: unknown = JSON.parse(report.payload);
    if (!Array.isArray(parsed) || parsed.length > 2000) return null;
    const results: VerifiedModelOutcome[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      if (item.verified !== true || item.provenance !== "trusted_fixture_runner" ||
          typeof item.model !== "string" || !item.model.trim() ||
          typeof item.evaluationId !== "string" || !item.evaluationId.trim() ||
          typeof item.family !== "string" || !ALLOWED_FAMILIES.has(item.family) ||
          typeof item.correct !== "boolean") return null;
      const identity = JSON.stringify([item.model, item.family, item.evaluationId]);
      if (seen.has(identity)) return null;
      seen.add(identity);
      if (item.latencyMs !== undefined &&
          (typeof item.latencyMs !== "number" || !Number.isFinite(item.latencyMs) || item.latencyMs < 0)) return null;
      results.push(item as unknown as VerifiedModelOutcome);
    }
    return results;
  } catch { return null; }
}
