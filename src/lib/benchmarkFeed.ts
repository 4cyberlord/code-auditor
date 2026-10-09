import type { ModelCapability } from "./adaptiveModelRouting.ts";
import { capabilitiesFromSignedBenchmark } from "./authenticatedBenchmarkRouting.ts";
import type { SignedBenchmarkReport } from "./signedBenchmark.ts";

/**
 * Pull model-quality evidence only from a deployment-owned HTTPS endpoint.
 * Neither the URL nor the signing key may be supplied by user settings.
 * Fail closed for network, parsing, key, or signature failures.
 */
export async function loadAuthenticatedBenchmarkCapabilities(
  endpoint: string,
  pinnedKey: CryptoKey | null,
  fetcher: typeof fetch = fetch,
): Promise<ModelCapability[] | null> {
  if (!pinnedKey || !endpoint.startsWith("https://")) return null;
  try {
    const response = await fetcher(endpoint, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 2_500_000) return null;
    const raw = await response.text();
    if (raw.length > 2_500_000) return null;
    const report = JSON.parse(raw) as SignedBenchmarkReport;
    return await capabilitiesFromSignedBenchmark(report, pinnedKey);
  } catch { return null; }
}
