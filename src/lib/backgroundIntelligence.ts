import { routeProblem, routeUnparsedProblem, type ProblemRouting, type ProblemFamily } from "./problemRouting.ts";
import { selectAdaptiveModels, verifiedTextOnlyScreenshot, type ModelCapability, type RoutingDecision } from "./adaptiveModelRouting.ts";
import type { Extraction } from "./extraction.ts";

type Probe = { vision?: boolean | null; ok?: boolean; ms?: number };
type Model = { id: string; expertise?: readonly ProblemFamily[]; vision?: boolean; latencyMs?: number; costPerMillion?: number };
type Reading = { extraction?: Extraction | null; readerDetails?: readonly Pick<Extraction,"confidence"|"ambiguities">[]; agreement?: { agree: boolean } | null };

export interface BackgroundIntelligencePlan<T extends Model> {
  route: ProblemRouting;
  safeTextOnly: boolean;
  selection: RoutingDecision<T>;
}
/** Shared with Council Editor's desktop intelligence: configured models only,
 * attested vision capability, and no unverified image-to-text substitution.
 * Pure by design: usable by the cloud worker without a macOS/webview runtime.
 */
export function planBackgroundIntelligence<T extends Model>(args: {
  models: readonly T[];
  probes?: Readonly<Record<string, Probe | undefined>>;
  reading?: Reading | null;
  hasImages: boolean;
  passesImages: boolean;
  note?: string;
  count?: number;
}): BackgroundIntelligencePlan<T> {
  const extraction = args.reading?.extraction ?? null;
  const route = extraction ? routeProblem(extraction) : routeUnparsedProblem(args.note || "", args.hasImages);
  const safeTextOnly = verifiedTextOnlyScreenshot(
    args.hasImages,
    args.reading?.readerDetails ?? [],
    extraction,
    route,
  ) && args.reading?.agreement?.agree === true;
  const capabilities: ModelCapability[] = args.models.map(model => {
    const probe = args.probes?.[model.id];
    return {
      id: model.id,
      families: model.expertise,
      vision: typeof probe?.vision === "boolean" ? probe.vision : model.vision,
      verifiedVisual: probe?.vision === true,
      availability: probe?.ok === false ? "unknown" : "available",
      latencyMs: probe?.ok && Number.isFinite(probe.ms) ? probe.ms : model.latencyMs,
      costPerMillion: model.costPerMillion,
    };
  });
  return {
    route,
    safeTextOnly,
    selection: selectAdaptiveModels(
      args.models, model => model.id, route, capabilities, args.count ?? args.models.length,
      { passesImages: args.passesImages },
    ),
  };
}
