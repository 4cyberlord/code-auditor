import { routeProblem, routeUnparsedProblem } from "./problemRouting.ts";
import { selectAdaptiveModels, verifiedTextOnlyScreenshot } from "./adaptiveModelRouting.ts";
import type { Extraction } from "./extraction.ts";

/** A cloud job and a desktop run use the same conservative routing decisions. */
export interface CloudReading {
  extraction?: Extraction | null;
  context?: string;
  readerEvidence?: readonly Pick<Extraction, "confidence" | "ambiguities">[];
  agreement?: { agree: boolean } | null;
}

export interface CloudModel {
  id: string;
  expertise?: readonly import("./problemRouting.ts").ProblemFamily[];
  vision?: boolean;
  latencyMs?: number;
  costPerMillion?: number;
}

export interface CloudSettings {
  probes?: Record<string, { vision?: boolean | null; ok?: boolean; ms?: number } | undefined>;
}

export function cloudCapabilities(settings: CloudSettings, roster: readonly CloudModel[]) {
  return roster.map((entry) => {
    const probe = settings.probes?.[entry.id];
    return {
      id: entry.id,
      families: entry.expertise,
      vision: typeof probe?.vision === "boolean" ? probe.vision : entry.vision,
      verifiedVisual: probe?.vision === true,
      availability: probe && !probe.ok ? "unknown" as const : "available" as const,
      latencyMs: probe?.ok && Number.isFinite(probe.ms) ? probe.ms : entry.latencyMs,
      costPerMillion: entry.costPerMillion,
    };
  });
}

/** No fabricated specialist statistics; only configured models can be selected. */
export function routeCloudModels<T extends CloudModel>(
  settings: CloudSettings,
  configured: readonly T[],
  reading: CloudReading | null | undefined,
  passImages: boolean,
) {
  const extraction = reading?.extraction;
  const route = extraction && (extraction.problemSummary || extraction.observations?.length)
    ? routeProblem(extraction)
    : routeUnparsedProblem(reading?.context || "", passImages);
  const selection = selectAdaptiveModels(
    configured, (entry) => entry.id, route,
    cloudCapabilities(settings, configured),
    configured.length, { passesImages: passImages },
  );
  return { route, selection };
}

/** An accepted transcription requires two independent, confident readers. */
export function trustedCloudReading(reading: CloudReading | null | undefined): boolean {
  if (!reading?.extraction || reading.agreement?.agree !== true) return false;
  const route = routeProblem(reading.extraction);
  return verifiedTextOnlyScreenshot(
    true, reading.readerEvidence || [], reading.extraction, route,
  );
}
