/**
 * Provider catalogue.
 *
 * Model IDs move fast — every one of these is editable in Settings at runtime,
 * so a new release from any vendor is a text-field change, not a rebuild.
 * Defaults verified against vendor docs, August 2026.
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
  /** Suggestions shown as a datalist; the field stays free-text. */
  knownModels: string[];
  /** The same, for the gateway's namespaced catalogue. Verified August 2026. */
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
    knownModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    knownRouterModels: [
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.5-pro",
      "openai/gpt-5.3-codex",
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
    knownModels: ["kimi-k3", "kimi-k2.6", "kimi-k2.5", "moonshot-v1-128k-vision-preview"],
    knownRouterModels: [
      "moonshotai/kimi-k3",
      "moonshotai/kimi-k2.7-code",
      "moonshotai/kimi-k2.6",
      "moonshotai/kimi-k2.5",
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
    defaultModel: "claude-opus-5",
    /**
     * Verified against the TokenRouter catalogue 2026-08-25.
     *
     * claude-opus-5 exists in the catalogue but fails with "no access" on keys
     * that have not been explicitly entitled to it. claude-opus-4.6 is the
     * stable, broadly-accessible alternative and is the model used throughout
     * the council default bench.
     */
    defaultRouterModel: "anthropic/claude-opus-4.6",
    knownModels: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    knownRouterModels: [
      "anthropic/claude-opus-4.6",
      "anthropic/claude-fable-5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
      // Newer generation — available on keys with explicit access enabled.
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
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
    defaultModel: "gemini-3.7-flash",
    defaultRouterModel: "google/gemini-3.7-flash",
    knownModels: ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3-pro-image", "gemini-2.5-flash"],
    knownRouterModels: [
      "google/gemini-3.7-flash",
      "google/gemini-3.6-flash",
      "google/gemini-3.5-flash",
      "google/gemini-3.1-pro-preview",
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

export type GatewayId = typeof GATEWAY.id;

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

/**
 * Panes that exist only through the gateway. None at present.
 */
export const EXTRA_AGENTS: readonly ExtraAgent[] = [];

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
      free: true,
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
export type TransportId = ProviderId | GatewayId;

/**
 * Anything with a Keychain entry.
 *
 * Wider than `TransportId` on purpose: the panel's sessions database connection
 * string is a secret too. Keeping the two types apart is what keeps that secret
 * away from `routeFor`, where it would compete with the model keys.
 */
/**
 * Supabase Storage. Not a model — it is where screenshots live.
 *
 * A second credential rather than a second connection string, because they are
 * different secrets with different blast radii: the Postgres password reads and
 * writes rows, the `service_role` key reads and writes objects, and pasting one
 * into the other's box should fail loudly rather than half-work.
 *
 * The project URL is *not* asked for. It is derivable from the connection
 * string already in Settings, and asking someone to look up a value the app is
 * already holding is asking them to do our work.
 */
export const STORAGE = {
  /** Also the Keychain entry id. */
  id: "supabase_storage",
  label: "Supabase Storage",
  vendor: "Supabase",
  keyUrl: "https://supabase.com/dashboard/project/_/settings/api",
  keyHint: "eyJhbGciOi… (service_role)",
  requires: "the service_role key, not the anon key",
  bucket: "screenshots",
  accent: "#3ecf8e",
} as const;

export type StorageId = typeof STORAGE.id;

export type KeyId = TransportId | "database-url" | StorageId;

/** The transcriber's human label. No key: the engine is on the device. */
export const TRANSCRIBER_LABEL = "Apple Vision";
