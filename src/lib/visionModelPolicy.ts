import { primaryModelId } from "./primaryModels.ts";

/** Independent screenshot specialists, limited to the existing approved models. */
export const SPECIALIST_VISION_MODELS = [
  "gemini-3.1-pro", "claude-opus-5.5", "gpt-5.6-sol",
] as const;

/** Require a real native test-image reply, never a catalogue/0-ms assertion. */
export function isVerifiedImageProbe(probe: {
  ok?: boolean; vision?: boolean | null; ms?: number;
  visionNote?: string | null;
} | null | undefined): boolean {
  return probe?.ok === true && probe.vision === true &&
    typeof probe.ms === "number" && Number.isFinite(probe.ms) && probe.ms > 0 &&
    /^Read the test image correctly \("red"\)\./i.test(String(probe.visionNote || ""));
}

export function preferredVisionModels(available: readonly string[], max = 3): string[] {
  const byId = new Map<string, string>();
  for (const route of available) {
    const id = primaryModelId(route);
    if (id && !byId.has(id)) byId.set(id, route);
  }
  return SPECIALIST_VISION_MODELS.slice(0, Math.max(0, max))
    .flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
}

export function verifiedImageProbes<T extends {
  ok?: boolean; vision?: boolean | null; ms?: number; visionNote?: string | null;
}>(probes: Readonly<Record<string, T | undefined>>): Record<string, T> {
  return Object.fromEntries(Object.entries(probes).filter(([,probe]) => isVerifiedImageProbe(probe))) as Record<string,T>;
}
