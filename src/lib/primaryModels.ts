/** The user's fixed model pool. A gateway may change the spelling, not the model. */
export const PRIMARY_MODEL_IDS = [
  "claude-opus-5.5",
  "claude-fable-5.1",
  "gpt-5.6-sol",
  "gemini-3.1-pro",
  "grok-4.6",
  "gpt-5.6-terra",
  "qwen3.8-max",
  "kimi-k3",
  "glm-5.3",
  "seed-2.1-pro",
] as const;

export type PrimaryModelId = (typeof PRIMARY_MODEL_IDS)[number];

const MODEL_LABELS: Record<PrimaryModelId, string> = {
  "claude-opus-5.5": "Claude Opus 5.5", "claude-fable-5.1": "Claude Fable 5.1",
  "gpt-5.6-sol": "GPT 5.6 Sol", "gemini-3.1-pro": "Gemini 3.1 Pro",
  "grok-4.6": "Grok 4.6", "gpt-5.6-terra": "GPT 5.6 Terra",
  "qwen3.8-max": "Qwen 3.8 Max", "kimi-k3": "Kimi K3",
  "glm-5.3": "GLM 5.3", "seed-2.1-pro": "Seed 2.1 Pro",
};

// Explicit aliases prevent a same-vendor fallback from silently changing the
// requested model version. The catalogue still has to confirm the exact route.
const ROUTE_ALIASES: Record<PrimaryModelId, readonly string[]> = {
  "claude-opus-5.5": ["claude-opus-5.5", "anthropic/claude-opus-5.5", "claude/opus-5-5", "claude/opus-5.5"],
  "claude-fable-5.1": ["claude-fable-5.1", "anthropic/claude-fable-5.1", "claude/fable-5-1", "claude/fable-5.1"],
  "gpt-5.6-sol": ["gpt-5.6-sol", "openai/gpt-5.6-sol", "openai/gpt-5-6-sol"],
  "gemini-3.1-pro": ["gemini-3.1-pro", "google/gemini-3.1-pro", "google/gemini-3-1-pro"],
  "grok-4.6": ["grok-4.6", "x-ai/grok-4.6", "xai/grok-4-6", "xai/grok-4.6"],
  "gpt-5.6-terra": ["gpt-5.6-terra", "openai/gpt-5.6-terra", "openai/gpt-5-6-terra"],
  "qwen3.8-max": ["qwen3.8-max", "qwen/qwen3.8-max", "qwen/qwen3-8-max"],
  "kimi-k3": ["kimi-k3", "moonshotai/kimi-k3", "moonshot/kimi-k3"],
  "glm-5.3": ["glm-5.3", "z-ai/glm-5.3", "zai/glm-5-3", "glm/5-3", "glm/5.3"],
  "seed-2.1-pro": ["seed-2.1-pro", "bytedance/seed-v2-1-pro", "bytedance/seed-2.1-pro"],
};

const MODEL_BY_ROUTE = new Map<string, PrimaryModelId>(
  PRIMARY_MODEL_IDS.flatMap(id => ROUTE_ALIASES[id].map(alias => [alias, id] as const))
);

export function primaryModelId(route: unknown): PrimaryModelId | null {
  if (typeof route !== "string") return null;
  return MODEL_BY_ROUTE.get(route.trim().toLowerCase()) ?? null;
}

export function isPrimaryModel(route: unknown): boolean {
  return primaryModelId(route) !== null;
}

export function primaryModelLabel(route: string): string | null {
  const id = primaryModelId(route);
  return id ? MODEL_LABELS[id] : null;
}

export function primaryModelFamily(route: string): string | null {
  switch (primaryModelId(route)) {
    case "claude-opus-5.5":
    case "claude-fable-5.1": return "anthropic";
    case "gpt-5.6-sol":
    case "gpt-5.6-terra": return "openai";
    case "gemini-3.1-pro": return "google";
    case "grok-4.6": return "xai";
    case "qwen3.8-max": return "qwen";
    case "kimi-k3": return "moonshot";
    case "glm-5.3": return "glm";
    case "seed-2.1-pro": return "bytedance";
    default: return null;
  }
}

/** A listed alias of the same model; never the next model in its family. */
export function listedPrimaryRoute(requested: string, catalogue: readonly string[]): string | null {
  const id = primaryModelId(requested);
  if (!id) return null;
  return catalogue.find(route => primaryModelId(route) === id) ?? null;
}

export function primaryCatalog(catalogue: readonly string[]): string[] {
  const seen = new Set<PrimaryModelId>();
  return catalogue.filter(route => {
    const id = primaryModelId(route);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** An attempted route for a key whose catalogue is temporarily unavailable. */
export function preferredPrimaryRoute(id: PrimaryModelId, gateway: "tokenrouter" | "wiro" | "cleanapis"): string {
  if (gateway === "cleanapis") return id;
  const aliases = ROUTE_ALIASES[id];
  if (gateway === "wiro") {
    return aliases.find(alias => /^(?:claude|openai|google|xai|qwen|moonshotai|glm|bytedance)\//.test(alias) &&
      !alias.includes(".") && !alias.startsWith("qwen/qwen3.8")) ?? aliases[1] ?? id;
  }
  return aliases.find(alias => alias.includes("/") && alias.includes(".")) ?? aliases[1] ?? id;
}
