/**
 * Provider catalogue.
 *
 * Defaults belong to the user's fixed ten-model pool. Gateway discovery and
 * live requests establish which exact routes the current credential can use.
 */

export type ProviderId = "openai" | "moonshot" | "anthropic" | "gemini";

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  vendor: string;
  /** Where the user gets a key, when going direct. */
  keyUrl: string;
  keyHint: string;
  defaultModel: string;
  /**
   * The same model addressed through the gateway.
   *
   * Aggregators namespace their catalogue by vendor, so `claude-opus-5` direct
   * is `anthropic/claude-opus-5` through the router. Keeping the two ids
   * separate means switching route does not silently ask for a model that does
   * not exist on the other side.
   */
  defaultRouterModel: string;
  /** Approved suggestions shown as a datalist. */
  knownModels: string[];
  /** The same identities, using TokenRouter's namespaced spelling. */
  knownRouterModels: string[];
  defaultBaseUrl: string;
  accent: string;
  /**
   * Whether this provider's *default* model reads images. It gates which
   * providers are offered as extractors, nothing else — every model field here
   * is free text, so a user who points a pane at a vision model we have never
   * heard of is not stopped by this flag.
   */
  vision: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  openai: {
    id: "openai",
    label: "GPT",
    vendor: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    defaultModel: "gpt-5.6-sol",
    defaultRouterModel: "openai/gpt-5.6-sol",
    knownModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    knownRouterModels: [
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
    ],
    defaultBaseUrl: "https://api.openai.com/v1",
    accent: "#10a37f",
    vision: true,
  },
  moonshot: {
    id: "moonshot",
    label: "Kimi",
    vendor: "Moonshot AI",
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    keyHint: "sk-…",
    defaultModel: "kimi-k3",
    defaultRouterModel: "moonshotai/kimi-k3",
    knownModels: ["kimi-k3"],
    knownRouterModels: [
      "moonshotai/kimi-k3",
    ],
    // api.moonshot.cn for the China region.
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    accent: "#7c5cff",
    vision: true,
  },
  anthropic: {
    id: "anthropic",
    label: "Claude",
    vendor: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    defaultModel: "claude-opus-5.5",
    /** Exact identity requested by the user; availability is checked live. */
    defaultRouterModel: "anthropic/claude-opus-5.5",
    knownModels: ["claude-opus-5.5", "claude-fable-5.1"],
    knownRouterModels: [
      "anthropic/claude-opus-5.5",
      "anthropic/claude-fable-5.1",
    ],
    defaultBaseUrl: "https://api.anthropic.com/v1",
    accent: "#d97757",
    vision: true,
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    vendor: "Google",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    defaultModel: "gemini-3.1-pro",
    defaultRouterModel: "google/gemini-3.1-pro",
    knownModels: ["gemini-3.1-pro"],
    knownRouterModels: [
      "google/gemini-3.1-pro",
    ],
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    accent: "#4285f4",
    vision: true,
  },
};

/**
 * The transcriber, as a label.
 *
 * No key and no settings entry -- Apple Vision is on the device, so there is
 * nothing to configure. This is the text the reading puts on the transcription
 * so "what read this" is legible from the saved document.
 */

export const PROVIDER_ORDER: ProviderId[] = ["openai", "moonshot", "anthropic", "gemini"];

/** Providers whose default model can be handed a screenshot. */
export const VISION_PROVIDERS: ProviderId[] = PROVIDER_ORDER.filter((p) => PROVIDERS[p].vision);

// ------------------------------------------------------------------ gateway

/**
 * TokenRouter is a route, not a model.
 *
 * It was briefly a fifth pane sitting next to GPT and Claude, which was wrong:
 * it is not a vendor with an opinion, it is one OpenAI-compatible endpoint in
 * front of everyone else's. Modelled as a peer it competed for a pane with the
 * models it exists to deliver, and it made "which four models answered" depend
 * on billing rather than on the panel.
 *
 * As a gateway it does the thing it is actually for: one key, and all four panes
 * work. Without it each pane needs its own vendor key, and the panes without one
 * simply do not run.
 */
export const GATEWAY = {
  /** Also the Keychain entry id, which is why it is a bare string. */
  id: "tokenrouter",
  label: "TokenRouter",
  vendor: "TokenRouter",
  keyUrl: "https://www.tokenrouter.com/",
  keyHint: "sk-…",
  defaultBaseUrl: "https://api.tokenrouter.com/v1",
  modelsUrl: "https://www.tokenrouter.com/models/",
  accent: "#f2994a",
} as const;

// ------------------------------------------------------------------ Wiro gateway

/**
 * Wiro is a unified AI API platform with an OpenAI-compatible LLM endpoint.
 *
 * Base URL  : https://llm.wiro.ai/v1
 * Auth      : Authorization: Bearer <api-key> for API-Key-Only projects, or
 *             Authorization: Bearer <api-key>:<api-secret> for Signature-Based
 *             projects on Wiro's Direct LLM Gateway.
 * Model IDs : vendor-prefixed, but with a different namespace than TokenRouter.
 *             TokenRouter uses  "anthropic/claude-opus-5"
 *             Wiro uses         "claude/opus-5"
 *             TokenRouter uses  "google/gemini-3.7-flash"
 *             Wiro uses         "google/gemini-3.7-flash"  (same for Google)
 *             TokenRouter uses  "openai/gpt-5.6-sol"
 *             Wiro uses         "openai/gpt-5-6-sol"       (hyphens, not dots)
 *
 * Wiro has its own Keychain entry, so changing routers never overwrites a
 * TokenRouter key. Both credentials remain available when switching back.
 *
 * Docs: https://wiro.ai/docs/completions-api
 */
export const WIRO_GATEWAY = {
  /** Also the Keychain entry id. */
  id: "wiro",
  label: "Wiro",
  vendor: "Wiro AI",
  keyUrl: "https://wiro.ai/auth/signup",
  keyHint: "sk-…",
  defaultBaseUrl: "https://llm.wiro.ai/v1",
  modelsUrl: "https://wiro.ai/models",
  accent: "#6c47ff",
  /**
   * Expected aliases for the approved pane models. These do not promise that
   * Wiro serves every version; the current catalogue and probe decide that.
   */
  defaultRouterModels: {
    openai: "openai/gpt-5-6-sol",
    moonshot: "moonshotai/kimi-k3",
    anthropic: "claude/opus-5-5",
    gemini: "google/gemini-3-1-pro",
  } as Record<ProviderId, string>,
} as const;

/** Clean APIs uses the unprefixed IDs from its OpenAI-compatible catalogue. */
export const CLEANAPIS_GATEWAY = {
  id: "cleanapis",
  label: "Clean API",
  vendor: "Clean APIs",
  keyUrl: "https://cleanapis.com/dashboard/api-keys",
  keyHint: "cc_…",
  defaultBaseUrl: "https://cleanapis.com/v1",
  modelsUrl: "https://cleanapis.com/models",
  accent: "#28a888",
  defaultRouterModels: {
    openai: "gpt-5.6-sol",
    moonshot: "kimi-k3",
    anthropic: "claude-opus-5.5",
    gemini: "gemini-3.1-pro",
  } as Record<ProviderId, string>,
} as const;

/**
 * Every gateway the app knows about, in display order.
 *
 * Used by the Settings router selector to let users switch between gateways
 * without typing a URL by hand. Adding a new gateway here is all that is
 * required — the selector, the base-URL field and the router-model fields all
 * drive off this list.
 */
export interface GatewayPreset {
  id: GatewayId;
  label: string;
  vendor: string;
  keyUrl: string;
  keyHint: string;
  defaultBaseUrl: string;
  modelsUrl: string;
  accent: string;
  /** Default router model ids for the four provider panes. */
  defaultRouterModels: Record<ProviderId, string>;
}

export const KNOWN_GATEWAYS: GatewayPreset[] = [
  {
    id: GATEWAY.id,
    label: GATEWAY.label,
    vendor: GATEWAY.vendor,
    keyUrl: GATEWAY.keyUrl,
    keyHint: GATEWAY.keyHint,
    defaultBaseUrl: GATEWAY.defaultBaseUrl,
    modelsUrl: GATEWAY.modelsUrl,
    accent: GATEWAY.accent,
    defaultRouterModels: {
      openai: PROVIDERS.openai.defaultRouterModel,
      moonshot: PROVIDERS.moonshot.defaultRouterModel,
      anthropic: PROVIDERS.anthropic.defaultRouterModel,
      gemini: PROVIDERS.gemini.defaultRouterModel,
    },
  },
  {
    id: WIRO_GATEWAY.id,
    label: WIRO_GATEWAY.label,
    vendor: WIRO_GATEWAY.vendor,
    keyUrl: WIRO_GATEWAY.keyUrl,
    keyHint: WIRO_GATEWAY.keyHint,
    defaultBaseUrl: WIRO_GATEWAY.defaultBaseUrl,
    modelsUrl: WIRO_GATEWAY.modelsUrl,
    accent: WIRO_GATEWAY.accent,
    defaultRouterModels: WIRO_GATEWAY.defaultRouterModels,
  },
  {
    id: CLEANAPIS_GATEWAY.id,
    label: CLEANAPIS_GATEWAY.label,
    vendor: CLEANAPIS_GATEWAY.vendor,
    keyUrl: CLEANAPIS_GATEWAY.keyUrl,
    keyHint: CLEANAPIS_GATEWAY.keyHint,
    defaultBaseUrl: CLEANAPIS_GATEWAY.defaultBaseUrl,
    modelsUrl: CLEANAPIS_GATEWAY.modelsUrl,
    accent: CLEANAPIS_GATEWAY.accent,
    defaultRouterModels: CLEANAPIS_GATEWAY.defaultRouterModels,
  },
];

// ----------------------------------------------------------------- the panel

/** A model on a free tier. Not in the roster, but the type needs to exist so
 *  helpers iterating over it compile. */
export interface FreeRouterModel {
  id: string;
  label: string;
  vendor: string;
  vision: boolean;
}

/**
 * Models the gateway serves at no cost. None at present; models that qualify
 * (Qwen's free tier, Nemotron's reasoning demo) were removed from the roster
 * at the user's request, not blocked by the app.
 */
export const FREE_ROUTER_MODELS: readonly FreeRouterModel[] = [];

/**
 * The transcriber. On Apple's Vision framework at launch, which is why nothing
 * below mentions a key: there is no request quota to count and no account to
 * configure -- the engine lives on the device.
 *
 * It does one job -- pixels to characters -- and does not understand what it
 * read. That is exactly why it belongs here: the app needed a transcriber and
 * had been paying a reasoning model to be one, on a five-requests-a-minute
 * budget that is unchanged and unspent here. So the expensive call stops being
 * an image call whenever the screen is text at all.
 */

// ----------------------------------------------------------------- the panel

/** A pane that lives only on the gateway, with a fixed id and label. */
export interface ExtraAgent {
  id: string;
  label: string;
  vendor: string;
  model: string;
  accent: string;
  vision: boolean;
}

/** The remaining approved models can compete for the four solver seats. */
export const EXTRA_AGENTS: readonly ExtraAgent[] = [
  { id: "fable", label: "Claude Fable", vendor: "Anthropic", model: "claude-fable-5.1", accent: "#d97757", vision: true },
  { id: "terra", label: "GPT Terra", vendor: "OpenAI", model: "gpt-5.6-terra", accent: "#10a37f", vision: true },
  { id: "grok", label: "Grok", vendor: "xAI", model: "grok-4.6", accent: "#a2a4aa", vision: true },
  { id: "qwen", label: "Qwen", vendor: "Alibaba", model: "qwen3.8-max", accent: "#8465dc", vision: true },
  { id: "glm", label: "GLM", vendor: "Zhipu AI", model: "glm-5.3", accent: "#52a0e8", vision: true },
  { id: "seed", label: "Seed", vendor: "ByteDance", model: "seed-2.1-pro", accent: "#ef9050", vision: true },
];

export type ExtraAgentId = (typeof EXTRA_AGENTS)[number]["id"];

/** Anything that can occupy a pane. */
export type AgentId = ProviderId | ExtraAgentId;

/** Every pane the panel can show, in display order. */
export const ALL_AGENTS: AgentId[] = [
  ...PROVIDER_ORDER,
  ...EXTRA_AGENTS.map((e) => e.id),
];

export const isExtraAgent = (id: AgentId): id is ExtraAgentId =>
  EXTRA_AGENTS.some((e) => e.id === id);

export const extraAgent = (id: AgentId) => EXTRA_AGENTS.find((e) => e.id === id);

export interface AgentSpec {
  id: AgentId;
  label: string;
  vendor: string;
  accent: string;
  vision: boolean;
  /** True when the only way to reach it is the gateway. */
  routerOnly: boolean;
  /** Free at the point of use. Worth saying on the pane. */
  free: boolean;
}

/**
 * One description for whatever is in a pane.
 *
 * Every call site that wanted a label, a colour or a vendor used to index
 * `PROVIDERS` directly, which silently assumed a pane was always one of four
 * vendors. This is the single place that assumption is now allowed to live.
 */
export function agentSpec(id: AgentId): AgentSpec {
  const extra = extraAgent(id);
  if (extra) {
    return {
      id,
      label: extra.label,
      vendor: extra.vendor,
      accent: extra.accent,
      vision: extra.vision,
      routerOnly: true,
      free: false,
    };
  }
  const p = PROVIDERS[id as ProviderId];
  if (!p) {
    // An id from an older build of the app -- "tokenrouter" was a provider
    // before it became the gateway, and it is still sitting in people's saved
    // settings. Iteration is over `ALL_AGENTS` so a stale id should never reach
    // here, but throwing inside a render over a leftover localStorage key would
    // blank the whole window, and this costs four lines.
    return {
      id,
      label: String(id),
      vendor: "unknown",
      accent: "var(--text-faint)",
      vision: false,
      routerOnly: true,
      free: false,
    };
  }
  return {
    id,
    label: p.label,
    vendor: p.vendor,
    accent: p.accent,
    vision: p.vision,
    routerOnly: false,
    free: false,
  };
}

/** Anything that can be the *transport* of a request, as opposed to the vendor
 * whose model answers it.
 *
 * These are two different things and conflating them is what made TokenRouter a
 * pane in the first place. A pane is always one of the four vendors; the wire it
 * travels over is either that vendor or the gateway. It doubles as the Keychain
 * entry id, because a credential belongs to whoever you are actually talking to.
 */
export type GatewayId = typeof GATEWAY.id | typeof WIRO_GATEWAY.id | typeof CLEANAPIS_GATEWAY.id;

/** Finds the saved gateway preset, retaining TokenRouter for older settings. */
export const gatewayPreset = (id: string | null | undefined): GatewayPreset =>
  KNOWN_GATEWAYS.find((gateway) => gateway.id === id) ?? KNOWN_GATEWAYS[0];

export type TransportId = ProviderId | GatewayId;

/**
 * Anything with a Keychain entry.
 *
 * Wider than `TransportId` on purpose: the panel's sessions database connection
 * string is a secret too. Keeping the two types apart is what keeps that secret
 * away from `routeFor`, where it would compete with the model keys.
 */
/**
 * Screenshot storage metadata. Upload credentials are issued by the server API.
 * Keep the historical key id for detecting/removing Keychain credentials that
 * predate server-signed uploads; never request a new service-role key here.
 */
export const STORAGE = {
  /** Also the Keychain entry id. */
  id: "supabase_storage",
  label: "Supabase Storage",
  vendor: "Supabase",
  bucket: "screenshots",
  accent: "#3ecf8e",
} as const;

export type StorageId = typeof STORAGE.id;

export type KeyId = TransportId | "database-url" | StorageId | "azure_storage_connection_string";

/** The transcriber's human label. No key: the engine is on the device. */
export const TRANSCRIBER_LABEL = "Apple Vision";
