"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import SettingsGlyph from "./SettingsGlyph";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ALL_AGENTS,
  EXTRA_AGENTS,
  FREE_ROUTER_MODELS,
  KNOWN_GATEWAYS,
  gatewayPreset,
  agentSpec,
  PROVIDERS,
  PROVIDER_ORDER,
  type ProviderId,
  STORAGE,
} from "@/lib/models";
import { MAX_IMAGES, MAX_TOKENS_RANGE, routeFor, useStore, type Route } from "@/lib/store";
import { endpointForCouncilModel } from "@/lib/council";
import { HOME_ZONE, detectZone, isUsableZone, zoneLabel } from "@/lib/when";
import * as bridge from "@/lib/bridge";
import AccountCard from "./AccountCard";
import HelperCard from "./HelperCard";
import { classifyProbeResult } from "@/lib/probeFit";
import { SELECTABLE_PRIMARY_MODEL_IDS, preferredPrimaryRoute, primaryCatalog, primaryModelId } from "@/lib/primaryModels";
import { PIN_LENGTH, authReauthenticate, reason, sanitizePin } from "@/lib/auth";
import { refreshOfficialLanguageSources, type LanguageRefreshResult } from "@/lib/languageKnowledge";

/**
 * One probe truth badge.
 *
 * A red "failed" is an accusation the model cannot answer, and it is what you
 * see for everything from "the key cannot spend on this model" to "your
 * network dropped". The classifier reads the provider's own reason and says
 * why, or — when the model lives on an endpoint the probe does not speak — it
 * says that instead and does not call it a failure at all.
 */
function ProbeBadge({
  probe,
  modelId,
}: {
  probe: { ok: boolean; ms: number; error: string | null };
  modelId?: string;
}) {
  const setEndpointFor = useStore((s) => s.setEndpointFor);
  if (probe.ok) {
    return (
      <span className="badge" data-tone="good" title={`Answered in ${probe.ms}ms`}>
        {probe.ms}ms
      </span>
    );
  }
  const rep = classifyProbeResult("", false, probe.error ?? null, probe.ms);
  if (rep.status === "unsupported" && modelId) {
    return (
      <span className="badge" data-tone="warn" title={rep.detail ?? rep.summary}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Different endpoint
          <button
            className="btn tiny ghost"
            style={{ padding: "0 6px", height: "auto", lineHeight: 1.2, fontSize: 10 }}
            onClick={() => void setEndpointFor(modelId, "responses")}
            title="Probe again over the Responses API"
          >
            Use Responses
          </button>
        </span>
      </span>
    );
  }
  return (
    <span
      className="badge"
      data-tone={rep.status === "unsupported" ? "warn" : "bad"}
      title={rep.detail ? `${rep.summary}\n${rep.detail}` : rep.summary}
    >
      {rep.status === "unsupported" ? "different endpoint" : "failed"}
    </span>
  );
}

function VisionBadge({
  advertised, vision, note,
}: { advertised?: boolean; vision?: boolean | null; note?: string | null }) {
  if (vision == null && advertised == null) return null;
  return <>
    {advertised != null && <span className="badge" data-tone={advertised ? "good" : "warn"}
      title={advertised
        ? "The gateway catalogue lists image input for this model. This is not a live image-reading result."
        : "The gateway catalogue does not list image input for this model."}>
      {advertised ? "vision: yes (catalog)" : "vision: no (catalog)"}
    </span>}
    {vision != null && <span className="badge" data-tone={vision ? "good" : "warn"}
      title={note || "The live image check has not confirmed image reading."}>
      {vision ? "image read: verified" : "image read: not verified"}
    </span>}
  </>;
}

function SensitiveSettingsGate({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  const [verified, setVerified] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (pin.length !== PIN_LENGTH || busy) return;
    setBusy(true);
    setError(null);
    try {
      await authReauthenticate(pin);
      setVerified(true);
      setPin("");
    } catch (err) {
      setError(reason(err));
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  if (verified) return <>{children}</>;

  return (
    <form
      className="provider-card"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="top">
        <span className="name">{title}</span>
        <span className="spacer" />
        <span className="badge" data-tone="warn">
          locked
        </span>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        {detail}
      </p>
      <div className="row">
        <label htmlFor={`reauth-${title.replace(/\W+/g, "-").toLowerCase()}`}>PIN</label>
        <div className="with-btn">
          <input
            id={`reauth-${title.replace(/\W+/g, "-").toLowerCase()}`}
            className="field mono"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={PIN_LENGTH}
            value={pin}
            onChange={(e) => setPin(sanitizePin(e.target.value))}
          />
          <button className="btn" type="submit" disabled={busy || pin.length !== PIN_LENGTH}>
            {busy ? "Checking…" : "Unlock"}
          </button>
        </div>
      </div>
      {error && (
        <p className="hint" style={{ margin: "0 0 6px", color: "var(--bad)" }}>
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * TokenRouter, as a route rather than a model.
 *
 * One key here and all four panes work. It sits above the vendor cards because
 * that is the order of the decision: how do these reach a model at all, and only
 * then, which models.
 */
/**
 * Where screenshots actually live.
 *
 * The project URL is not asked for: it is derivable from the connection string
 * already in Settings, and asking someone to look up a value the app is already
 * holding is asking them to do our work. One field, one key.
 */
function StorageCard() {
  // Retain the legacy key's removal path, but never request a privileged
  // service-role credential from desktop users again.
  const saved = useStore((s) => s.storageKey);
  const refreshKeys = useStore((s) => s.refreshKeys);
  const patchSettings = useStore((s) => s.patchSettings);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [azureSaved, setAzureSaved] = useState(false);
  const [connectionString, setConnectionString] = useState("");

  useEffect(() => {
    void bridge.hasApiKey("azure_storage_connection_string").then(setAzureSaved);
  }, []);

  const saveAzure = async () => {
    const value = connectionString.trim();
    if (!/(?:^|;)\s*AccountName=councilimages\s*(?:;|$)/i.test(value) ||
        !/(?:^|;)\s*AccountKey=[A-Za-z0-9+/=]+\s*(?:;|$)/i.test(value)) {
      setNote("Paste the full HTTPS connection string for the councilimages storage account.");
      return;
    }
    setBusy(true); setNote(null);
    try {
      await bridge.setApiKey("azure_storage_connection_string", value);
      setConnectionString("");
      setAzureSaved(true);
      patchSettings({ probes: {} });
      await refreshKeys();
      setNote("Azure connection saved to your signed-in account's protected secrets.");
    } catch (err) { setNote(String(err)); }
    finally { setBusy(false); }
  };

  const removeAzure = async () => {
    setBusy(true); setNote(null);
    try {
      await bridge.deleteApiKey("azure_storage_connection_string");
      setAzureSaved(false);
      await refreshKeys();
      setNote("Azure connection removed. Choose Supabase until a new key is saved.");
    } catch (err) { setNote(String(err)); }
    finally { setBusy(false); }
  };

  const removeLegacyKey = async () => {
    setBusy(true);
    setNote(null);
    try {
      await bridge.deleteApiKey(STORAGE.id);
      await refreshKeys();
      setNote("Legacy service-role credential removed from this device.");
    } catch (err) {
      setNote(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-card">
      <div className="top">
        <span className="dot" style={{ background: STORAGE.accent }} />
        <span className="name">Screenshot Storage</span>
        <span className="vendor">Private Azure Blob Storage</span>
        <span className="badge" data-tone={azureSaved ? "good" : "warn"}>
          {azureSaved ? "Azure key saved" : "Azure setup needed"}
        </span>
      </div>
      <p className="hint">
        All new screenshots use the private Azure container <span className="mono">council-images</span>
        {" "}in <span className="mono">councilimages</span>. Existing historical captures remain in their
        original private bucket so prior sessions continue to work.
      </p>
      <div className="row">
        <label htmlFor="azure-connection">Azure connection string</label>
        <div className="with-btn">
          <input id="azure-connection" className="field mono" type="password"
            autoComplete="off" placeholder={azureSaved ? "Saved — paste a replacement" : "Paste key1 connection string"}
            value={connectionString} onChange={(event) => setConnectionString(event.target.value)} />
          <button className="btn tiny ghost" disabled={busy || !connectionString.trim()}
            onClick={() => void saveAzure()}>{busy ? "Saving…" : "Save"}</button>
          {azureSaved && <button className="btn tiny ghost" disabled={busy}
            onClick={() => void removeAzure()}>Remove</button>}
          {azureSaved && <button className="btn tiny ghost" disabled={busy}
            onClick={() => {
              setBusy(true); setNote("Testing Azure upload, private read, and deletion…");
              void bridge.testAzureStorage()
                .then(() => setNote("Azure upload, private read, and deletion all passed."))
                .catch((err) => setNote(`Azure test failed: ${String(err)}`))
                .finally(() => setBusy(false));
            }}>Test connection</button>}
        </div>
      </div>
      <p className="hint">Paste the full connection string from Azure → councilimages → Access keys → key1.
        It is stored as a server-side secret, never shown again in this window. Do not paste it in chat.
        {!azureSaved ? " Azure uploads will fail until this is saved." : ""}</p>
      {saved && (
        <div className="row">
          <span>Legacy credential</span>
          <div className="with-btn">
            <span className="hint">An older storage credential is still saved locally.</span>
            <button className="btn tiny ghost" disabled={busy} onClick={() => void removeLegacyKey()}>
              {busy ? "Removing…" : "Remove old key"}
            </button>
          </div>
        </div>
      )}
      {note && <p className="hint" style={{ color: "var(--text)" }}>{note}</p>}
    </div>
  );
}

interface CodingModelChoice {
  key: string;
  id: string;
  label: string;
  route: Route | null;
  available: boolean;
  reason: string;
}

function supportsCodingTools(route: Route | null): boolean {
  return !!route && ["openai", "moonshot", "tokenrouter", "wiro", "cleanapis"].includes(route.provider);
}

function projectNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function CodingSettingsCard() {
  const settings = useStore((s) => s.settings);
  const keys = useStore((s) => s.keys);
  const gatewayKey = useStore((s) => s.gatewayKey);
  const patch = useStore((s) => s.patchSettings);
  const [note, setNote] = useState<string | null>(null);

  const choices = useMemo<CodingModelChoice[]>(
    () =>
      ALL_AGENTS.filter((id) => settings.enabled[id]).map((id) => {
        const spec = agentSpec(id);
        const route = routeFor(id, settings, keys, gatewayKey);
        const endpoint = route && settings.gatewayId === "tokenrouter"
          ? endpointForCouncilModel(settings.councilModels, route.model) : "chat";
        const unsupportedEndpoint = endpoint !== "chat";
        const unsupportedProvider = !supportsCodingTools(route);
        const available = !!route && !unsupportedEndpoint && !unsupportedProvider;
        const reason = !route
          ? "Setup needed"
          : unsupportedEndpoint || unsupportedProvider
            ? "Unavailable"
            : "Ready";
        return {
          key: `${route?.provider ?? "missing"}-${id}`,
          id: route?.model ?? id,
          label: `${spec.label} · ${route?.model ?? "not configured"}`,
          route,
          available,
          reason,
        };
      }),
    [gatewayKey, keys, settings]
  );

  const selected =
    choices.find((choice) => choice.available && choice.id === settings.codingModel) ??
    choices.find((choice) => choice.available) ??
    null;

  const chooseProjectRoot = async () => {
    setNote(null);
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Choose Coding Project Folder",
      });
      if (typeof picked === "string" && picked.trim()) {
        patch({
          codingProjectRoot: picked,
          codingProjectName: settings.codingProjectName || projectNameFromPath(picked),
        });
      }
    } catch (err) {
      setNote(`Could not open folder picker: ${String(err).replace(/^Error:\s*/, "")}`);
    }
  };

  return (
    <div className="provider-card">
      <div className="top">
        <span className="dot" style={{ background: "var(--accent)" }} />
        <span className="name">Coding agent</span>
        <span className="vendor">Model, project, and run controls</span>
        <span className="badge" data-tone={selected?.available ? "good" : "warn"}>
          {selected?.reason ?? "No Supported Model"}
        </span>
      </div>

      <div className="row">
        <label htmlFor="coding-settings-model">Model</label>
        <select
          id="coding-settings-model"
          className="field mono"
          value={selected?.id ?? ""}
          onChange={(e) => patch({ codingModel: e.target.value })}
        >
          {!selected && <option value="">No Supported Model</option>}
          {choices.map((choice) => (
            <option
              key={choice.key}
              value={choice.id}
              disabled={!choice.available}
            >
              {choice.label}{choice.available ? "" : ` (${choice.reason})`}
            </option>
          ))}
        </select>
      </div>

      <div className="row">
        <label htmlFor="coding-project-name">Project Name</label>
        <input
          id="coding-project-name"
          className="field"
          value={settings.codingProjectName}
          placeholder={projectNameFromPath(settings.codingProjectRoot) || "My app"}
          onChange={(e) => patch({ codingProjectName: e.target.value })}
        />
      </div>

      <div className="row">
        <label htmlFor="coding-project-root">Project Folder</label>
        <div className="with-btn">
          <input
            id="coding-project-root"
            className="field mono"
            value={settings.codingProjectRoot}
            placeholder="/path/to/project"
            spellCheck={false}
            onChange={(e) => patch({ codingProjectRoot: e.target.value })}
          />
          <button className="btn tiny" onClick={() => void chooseProjectRoot()}>
            Choose
          </button>
        </div>
      </div>

      <div className="row">
        <label htmlFor="coding-tokens">Run Limits</label>
        <div className="settings-two-fields">
          <input
            id="coding-tokens"
            className="field mono"
            type="number"
            min={MAX_TOKENS_RANGE.min}
            max={MAX_TOKENS_RANGE.max}
            step={512}
            value={settings.codingMaxTokens}
            onChange={(e) => patch({ codingMaxTokens: Number(e.target.value) || settings.codingMaxTokens })}
          />
          <input
            aria-label="Coding temperature"
            className="field mono"
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={settings.codingTemperature}
            onChange={(e) => patch({ codingTemperature: Number(e.target.value) || 0 })}
          />
        </div>
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.codingReasoning}
          onChange={(e) => patch({ codingReasoning: e.target.checked })}
        />
        <span>Use a more deliberate reasoning pass for Coding tasks</span>
      </label>

      <p className="hint">
        The Coding workspace shows only the project name. File tools still run inside the selected
        folder and cannot write outside it.
      </p>
      {note && <p className="hint" style={{ color: "var(--bad)" }}>{note}</p>}
    </div>
  );
}

/** The zone every timestamp in the app is read in. */
function TimeZoneCard() {
  const zone = useStore((s) => s.settings.timeZone);
  const patch = useStore((s) => s.patchSettings);
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft !== null && draft.trim()) patch({ timeZone: draft.trim() });
    setDraft(null);
  };

  const detected = detectZone();
  return (
    <div className="provider-card">
      <div className="top">
        <span className="name">Time zone</span>
        <span className="spacer" />
        <span className="badge" data-tone={isUsableZone(zone) ? "good" : "warn"}>
          {zoneLabel(zone)}
        </span>
      </div>
      <div className="row">
        <label htmlFor="tz">Zone</label>
        <div className="with-btn">
          <input
            id="tz"
            className="field mono"
            spellCheck={false}
            value={draft ?? zone}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
          {/* "Use detected" rather than "Use America/New_York": the zone name is
              already on screen twice, and a button whose width depends on a
              timezone string is a button that squeezes the field beside it. */}
          {detected !== zone && (
            <button
              className="btn tiny ghost"
              title={`Switch to ${detected}, this machine's own zone`}
              onClick={() => patch({ timeZone: detected })}
            >
              Use detected
            </button>
          )}
          {zone !== HOME_ZONE && (
            <button className="btn tiny ghost" onClick={() => patch({ timeZone: HOME_ZONE })}>
              Nashville
            </button>
          )}
        </div>
      </div>
      <p className="hint">
          Your chosen zone is saved, so history keeps using your home time. Nashville is Central:
          <span className="mono"> America/Chicago</span>. Changing this only changes display; saved
          timestamps are not rewritten.
      </p>
    </div>
  );
}

function GatewayCard() {
  const saved = useStore((s) => s.gatewayKey);
  const judgeProvider = useStore((s) => s.settings.judgeProvider);
  const extractors = useStore((s) => s.settings.extractors);
  const on = useStore((s) => s.settings.useGateway);
  const gatewayId = useStore((s) => s.settings.gatewayId);
  const baseUrl = useStore((s) => s.settings.gatewayBaseUrl);
  const routerModels = useStore((s) => s.settings.routerModels);
  const enabledAgents = useStore((s) => s.settings.enabled);
  const patch = useStore((s) => s.patchSettings);
  const refreshKeys = useStore((s) => s.refreshKeys);

  const [draft, setDraft] = useState("");
  const [draftSecret, setDraftSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // What the router says this key can actually reach. Null until asked, because
  // "we have not looked" and "there is nothing there" have to read differently.
  const probes = useStore((st) => st.settings.probes);
  const advertisedVision = useStore((st) => st.settings.advertisedVision);
  const probing = useStore((st) => st.probing);
  const probeError = useStore((st) => st.probeError);
  const testModels = useStore((st) => st.testModels);

  const [available, setAvailable] = useState<string[] | null>(null);
  const [catalogueFilter, setCatalogueFilter] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const active = saved && on;

  const councilModels = useStore((s) => s.settings.councilModels);
  const councilJudges = useStore((s) => s.settings.councilJudges);
  const synthesisModel = useStore((s) => s.settings.synthesisModel);
  const councilEnabled = useStore((s) => s.settings.councilEnabled);
  const gatewayRoute = useCallback((model: string) => {
    const id = primaryModelId(model);
    return id ? preferredPrimaryRoute(id, gatewayId) : "";
  }, [gatewayId]);

  // Panes, the judge, both readers, and the council roster — everything the
  // app will actually ask for, not just the four panes. Testing the router's
  // whole catalogue would be slower, cost more, and tell you about models
  // nothing here uses; but testing *less* than the council asks for is how a
  // typo in a roster becomes a failed seat forty minutes into a run.
  const modelsInUse = useMemo(() => {
    const ids = new Set<string>();
    for (const p of PROVIDER_ORDER) ids.add(routerModels[p] || PROVIDERS[p].defaultRouterModel);
    for (const e of EXTRA_AGENTS) {
      const id = primaryModelId(e.model);
      if (enabledAgents[e.id] && id) ids.add(preferredPrimaryRoute(id, gatewayId));
    }
    ids.add(routerModels[judgeProvider] || PROVIDERS[judgeProvider].defaultRouterModel);
    for (const x of extractors) {
      ids.add(routerModels[x] || PROVIDERS[x].defaultRouterModel);
    }
    if (councilEnabled) {
      for (const m of councilModels) ids.add(gatewayRoute(m.id));
      for (const j of councilJudges) ids.add(gatewayRoute(j.model));
      if (synthesisModel.trim()) ids.add(gatewayRoute(synthesisModel));
    }
    return [...ids].filter(Boolean);
  }, [routerModels, enabledAgents, gatewayId, gatewayRoute, judgeProvider, extractors, councilEnabled, councilModels, councilJudges, synthesisModel]);

  /** The catalogue as shown: every id the key can reach, narrowed by the filter. */
  const catalogue = useMemo(() => {
    const all = available ?? [];
    const q = catalogueFilter.trim().toLowerCase();
    return q ? all.filter((m) => m.toLowerCase().includes(q)) : all;
  }, [available, catalogueFilter]);

  /** Which seats a model holds, for the role tag beside its row. */
  const rolesFor = (m: string): string[] => {
    const roles: string[] = [];
    for (const p of PROVIDER_ORDER) {
      const id = routerModels[p] || PROVIDERS[p].defaultRouterModel;
      if (id === m) roles.push(PROVIDERS[p].label.toLowerCase());
    }
    for (const e of EXTRA_AGENTS) {
      const id = primaryModelId(e.model);
      if (id && preferredPrimaryRoute(id, gatewayId) === m) roles.push(e.label.toLowerCase());
    }
    const judgeId = routerModels[judgeProvider] || PROVIDERS[judgeProvider].defaultRouterModel;
    if (judgeId === m) roles.push("judge");
    for (const x of extractors) {
      const id = routerModels[x] || PROVIDERS[x].defaultRouterModel;
      if (id === m) roles.push("reader");
    }
    if (councilEnabled) {
      if (councilModels.some((x) => gatewayRoute(x.id) === m)) roles.push("solver");
      const seat = councilJudges.find((j) => gatewayRoute(j.model) === m);
      if (seat) roles.push(`judge/${seat.emphasis}`);
      if (gatewayRoute(synthesisModel) === m) roles.push("synthesis");
    }
    return roles;
  };

  // How far the image check has got, and how many seats came back able to read
  // one. Derived, so it clears itself the moment the seats change.
  const tested = modelsInUse.filter((m) => probes[m]).length;
  const working = modelsInUse.filter((m) => probes[m]?.ok).length;
  const modelsToImageCheck = modelsInUse.filter((model) => advertisedVision[model] !== false);
  const testedVision = modelsToImageCheck.filter((model) => probes[model]?.vision != null).length;

  const refreshModels = useCallback(async () => {
    setListing(true);
    setListError(null);
    try {
      const details = await bridge.listGatewayModelDetails(baseUrl, gatewayId);
      const ids = primaryCatalog(details.map(model => model.id));
      const approved = new Set(ids);
      const vision = gatewayId === "cleanapis"
        ? Object.fromEntries(details.filter(model =>
            approved.has(model.id) && Array.isArray(model.capabilities)).map(model => [
              model.id, model.capabilities!.some(capability => capability.toLowerCase() === "vision")
            ]))
        : {};
      setAvailable(ids);
      // Kept in settings, not just in this component's state: the Council reads
      // it before a run to skip seats this key cannot reach, and Settings is not
      // open when a run starts.
      patch({ availableModels: ids, advertisedVision: vision });
    } catch (err) {
      setAvailable(null);
      setListError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setListing(false);
    }
  }, [baseUrl, gatewayId, patch]);

  // This waited for a button press, on the reasoning that the listing call
  // spends one of the key's five requests a minute and a pane's tokens matter
  // more than pre-warming a dropdown. That held while the catalogue was only
  // autocomplete. Now that it is the answer to "what can this key reach",
  // making someone press a button to find out reads as the app not knowing —
  // so it asks once per opening, and the button stays as a refresh.
  useEffect(() => {
    if (!active) {
      queueMicrotask(() => {
        setAvailable(null);
        setCatalogueFilter("");
      });
      return;
    }
    if (available === null && !listing && !listError) {
      queueMicrotask(() => void refreshModels());
    }
  }, [active, available, listing, listError, refreshModels]);

  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      // Wiro's Direct LLM Gateway receives Signature-Based credentials as one
      // Bearer value, `API_KEY:API_SECRET`. Keeping its two dashboard values in
      // separate inputs avoids asking someone to infer that transport detail;
      // API-Key-Only Wiro projects simply leave the secret blank.
      const credential =
        gatewayId === "wiro" && draftSecret.trim()
          ? `${draft.trim()}:${draftSecret.trim()}`
          : draft.trim();
      await bridge.setApiKey(gatewayId, credential);
      patch({ availableModels: [], advertisedVision: {}, probes: {} });
      setDraft("");
      setDraftSecret("");
      await refreshKeys();
      // A different key is a different catalogue. Dropping what we knew makes
      // the effect ask again, rather than leaving the previous key's list on
      // screen looking like an answer about this one.
      setAvailable(null);
      setListError(null);
      setNote(`Saved. Every pane now routes through ${gatewayPreset(gatewayId).label}.`);
    } catch (err) {
      setNote(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await bridge.deleteApiKey(gatewayId);
      patch({ availableModels: [], advertisedVision: {}, probes: {} });
      await refreshKeys();
      setAvailable(null);
      setListError(null);
      setNote("Removed. Each pane now needs its own vendor key.");
    } finally {
      setBusy(false);
    }
  };

  const currentGateway = gatewayPreset(gatewayId);

  return (
    <div className="provider-card" data-accent="gateway">
      <div className="top">
        <span className="dot" style={{ background: currentGateway.accent }} />
        <span className="name">{currentGateway.label} Gateway</span>
        <span className="vendor">one key, approved models</span>
        {active ? (
          <span className="badge" data-tone="good">
            Routing all panes
          </span>
        ) : saved ? (
          <span className="badge" data-tone="warn">
            saved, switched off
          </span>
        ) : (
          <span className="badge" data-tone="warn">
            Not set up
          </span>
        )}
        <span className="spacer" />
        <button
          className="switch"
          data-on={on}
          aria-label={`Route through ${currentGateway.label}`}
          onClick={() => patch({ useGateway: !on })}
        />
      </div>

      <div className="row">
        <label htmlFor="gw-router">Router Provider</label>
        <div className="with-btn" style={{ gap: 8 }}>
          {KNOWN_GATEWAYS.map((gw) => {
            const isSelected = gatewayId === gw.id;
            return (
              <button
                key={gw.label}
                type="button"
                className={"btn" + (isSelected ? "" : " ghost")}
                style={{
                  fontWeight: isSelected ? 600 : 400,
                  borderColor: isSelected ? gw.accent : undefined,
                  background: isSelected ? `${gw.accent}15` : undefined,
                  color: isSelected ? gw.accent : undefined,
                }}
                onClick={() => {
                  patch({
                    gatewayId: gw.id,
                    gatewayBaseUrl: gw.defaultBaseUrl,
                    routerModels: { ...gw.defaultRouterModels },
                    availableModels: [],
                    advertisedVision: {},
                    probes: {},
                  });
                  void refreshKeys();
                  setDraft("");
                  setDraftSecret("");
                  setNote(null);
                  setAvailable(null);
                  setListError(null);
                }}
              >
                {gw.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="row">
        <label htmlFor="gw-key">API Key</label>
        <div className="with-btn">
          <input
            id="gw-key"
            className="field mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={saved ? "••••••••  saved" : currentGateway.keyHint}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
          />
          <button className="btn" onClick={() => void save()} disabled={busy || !draft.trim()}>
            Save
          </button>
          {saved && (
            <button className="btn ghost" onClick={() => void remove()} disabled={busy}>
              Remove
            </button>
          )}
        </div>
      </div>

      {gatewayId === "wiro" && (
        <div className="row">
          <label htmlFor="gw-secret">API Secret</label>
          <input
            id="gw-secret"
            className="field mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Required for Signature-Based projects"
            value={draftSecret}
            onChange={(e) => setDraftSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
          />
        </div>
      )}

      <div className="row">
        <label htmlFor="gw-base">Base URL</label>
        <input
          id="gw-base"
          className="field mono"
          value={baseUrl}
          spellCheck={false}
          placeholder={currentGateway.defaultBaseUrl}
          onChange={(e) => patch({ gatewayBaseUrl: e.target.value })}
        />
      </div>

      {active && (
        <>
          <div
            className="section-label"
            style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}
          >
            <span>Approved models listed by this key</span>
            <span className="spacer" />
              {available ? (
                <span className="chip">{available.length} on this key</span>
              ) : (
                <span className="chip" title="The catalogue is fetched on demand, through the rate budget, so a pane's tokens are never spent pre-warming a dropdown.">
                  Asking on demand
                </span>
              )}
            <button
              className="btn tiny ghost"
              onClick={() => void refreshModels()}
              disabled={listing}
            >
              {listing ? "Asking…" : "Refresh List"}
            </button>

            {/* The liveness probe that used to sit here — one text request per
                model, to learn whether the key could reach it — is gone. The
                catalogue answers that for every model at once, in one request.
                This is the question a listing genuinely cannot answer: a model
                can be listed, answer text perfectly, and still have its
                connection dropped the moment a picture is attached. It decides
                which seats get shown a screenshot, so it is worth its requests
                — and only the seats actually in use are asked. */}
            <button
              className="btn tiny ghost"
              onClick={() => void testModels(modelsToImageCheck, true)}
              disabled={probing || modelsToImageCheck.length === 0}
              title="Sends one image to each seat in use to verify the catalogue's vision claim."
            >
              {probing ? `${testedVision}/${modelsToImageCheck.length}` : "Check Which Can Read Images"}
            </button>
          </div>

          {gatewayId === "cleanapis" && modelsInUse.length > 0 && modelsToImageCheck.length === 0 && (
            <p className="hint" style={{ margin: "0 0 6px", color: "var(--warn)" }}>
              Clean API lists no enabled approved model with vision. Screenshot tasks need a model whose catalogue capabilities include vision.
            </p>
          )}

          {probeError && (
            <p className="hint" style={{ margin: "0 0 6px", color: "var(--bad)" }}>
              {probeError}
            </p>
          )}

          {tested > 0 && (
            <p className="hint" style={{ margin: "0 0 6px" }}>
              Text/API check: {working} of {tested} answered.{" "}
              {working < tested && (
                <>
                  The rest are marked below.{" "}
                  <b>Hover a failed badge to see the exact error {currentGateway.label} returned</b>{" "}
                  — that string is the whole diagnosis: <span className="mono">model_not_found</span>{" "}
                  means the id or entitlement, <span className="mono">429</span> means the
                  key&rsquo;s budget, <span className="mono">Timeout</span> means the model sat
                  there, and a provider&rsquo;s own message is its reason.
                </>
              )}
            </p>
          )}

          {/* The failures overhead, spelled out — the badge tooltip is the
              same text but you should not have to hover to learn a 429 from
              a 404. */}
          {modelsInUse
            .filter((m) => probes[m] && !probes[m].ok)
            .map((m) => (
              <p key={`err-${m}`} className="hint" style={{ margin: "0 0 4px", color: "var(--bad)" }}>
                <span className="mono">{m}</span> — {probes[m].error}
              </p>
            ))}

          {modelsInUse
            .filter((m) => probes[m]?.vision === false)
            .map((m) => (
              <p key={`vision-${m}`} className="hint" style={{ margin: "0 0 4px", color: "var(--warn)" }}>
                <span className="mono">{m}</span> — {advertisedVision[m] === true ? "vision listed; " : ""}live image reading not verified: {probes[m].visionNote || "No image response detail was returned."}
              </p>
            ))}

          {listError && (
            <p className="hint" style={{ margin: "0 0 6px", color: "var(--bad)" }}>
              Could not read the model list: {listError}
            </p>
          )}

          {/* Everything the key can reach, not only the seats it is filling.
              The catalogue used to exist only inside each field's autocomplete,
              which meant the one question people actually open this card to ask
              — "what am I allowed to use?" — could only be answered by typing
              into a box and hoping the dropdown appeared. It is a list; it
              should look like one. */}
          <div className="section-label" style={{ margin: "14px 0 2px", display: "flex", gap: 8, alignItems: "center" }}>
            <span className="spacer" />
            {available && (
              <span className="chip">
                {catalogueFilter.trim()
                  ? `${catalogue.length} of ${available.length}`
                  : `${available.length} models`}
              </span>
            )}
          </div>

          {listing && !available && <p className="hint" style={{ margin: "0 0 6px" }}>Asking the router…</p>}

          {available && available.length > 0 && (
            <>
              <input
                className="field mono"
                style={{ width: "100%", marginBottom: 6 }}
                placeholder="Filter — try 'claude', 'kimi', 'gpt'"
                value={catalogueFilter}
                spellCheck={false}
                onChange={(e) => setCatalogueFilter(e.target.value)}
              />
              <div className="catalogue" role="list">
                {catalogue.map((m) => {
                  const roles = rolesFor(m);
                  const probe = probes[m];
                  return (
                    <div
                      className="catalogue-row"
                      role="listitem"
                      key={m}
                      // Click to copy: the id is the thing you need in your hand
                      // to paste into a seat, and selecting monospace text out of
                      // a scrolling list by hand is a small misery.
                      onClick={() => {
                        void navigator.clipboard?.writeText(m);
                        setCopied(m);
                        window.setTimeout(() => setCopied((c) => (c === m ? null : c)), 1200);
                      }}
                      title="Click to copy this id"
                    >
                      <span className="mono catalogue-id">{m}</span>
                      {copied === m && <span className="badge" data-tone="good">Copied</span>}
                      {roles.length > 0 && <span className="role-tag">{roles.join(" + ")}</span>}
                      {probe && <ProbeBadge probe={probe} modelId={m} />}
                      <VisionBadge advertised={advertisedVision[m]}
                        vision={probe?.vision} note={probe?.visionNote} />
                    </div>
                  );
                })}
                {catalogue.length === 0 && (
                  <p className="hint" style={{ margin: 6 }}>
                    Nothing matches “{catalogueFilter}”.
                  </p>
                )}
              </div>
            </>
          )}
          {available && available.length === 0 && (
            <p className="hint">This key lists no models from the approved ten-model roster. Try another gateway or check this key&apos;s model access.</p>
          )}

          {/* The free panes have fixed ids, so they get a result line rather
              than an editable field. */}
          {EXTRA_AGENTS.filter(e => e.id !== "glm").map((e) => {
            const id = primaryModelId(e.model);
            const routeModel = id ? preferredPrimaryRoute(id, gatewayId) : e.model;
            const probe = probes[routeModel];
            return (
              <div className="row" key={e.id}>
                <label>{e.label}</label>
                <button type="button" className="switch" data-on={!!enabledAgents[e.id]}
                  aria-label={`Enable ${e.label} for solver selection`}
                  onClick={() => patch({ enabled: { ...enabledAgents, [e.id]: !enabledAgents[e.id] } })} />
                <span className="field mono" style={{ opacity: 0.7 }}>
                  {routeModel}
                </span>
                {probe && <ProbeBadge probe={probe} modelId={routeModel} />}
                <VisionBadge advertised={advertisedVision[routeModel]}
                  vision={probe?.vision} note={probe?.visionNote} />
              </div>
            );
          })}
        </>
      )}

      {active && FREE_ROUTER_MODELS.length > 0 && (
        <p className="hint" style={{ marginTop: 2 }}>
          <b>Free on this router:</b>{" "}
          {FREE_ROUTER_MODELS.map((m) => m.id).join(", ")} — both text-only, so put
          them in a pane and set Context to <b>Reading</b> under the Reading tab.
          Two vision models transcribe the screenshot and the free ones reason over
          that text, which costs you two paid calls instead of four.
        </p>
      )}

      <p className="hint">
        {note ?? (active
          ? "All panes use this endpoint, even those with their own vendor key. A shared route keeps model disagreements separate from routing differences."
          : "One key reaches GPT, Claude, Kimi, and Gemini. Without it, each pane needs its own vendor key.")}
        {" "}
        <button
          className="link"
          onClick={() => {
            void openUrl(currentGateway.modelsUrl).catch(() => window.open(currentGateway.modelsUrl, "_blank"));
          }}
        >
          Browse the model list
        </button>
      </p>

      {gatewayId === "wiro" && (
        <p className="hint">
          For Wiro Signature-Based authentication, enter both values from the Wiro dashboard. The
          app stores them together as the credential required by Wiro&apos;s Direct LLM Gateway. For an
          API-Key-Only Wiro project, leave API Secret blank.
        </p>
      )}
      {gatewayId === "cleanapis" && (
        <p className="hint">
          Paste your Clean APIs token above and save it. The token stays in your signed-in account&apos;s
          server-side secrets; the app only receives whether it is present. Only the ten approved
          models appear in this catalogue and can be selected for a run. Enable the token&apos;s
          inference and models:read scopes.
        </p>
      )}
    </div>
  );
}

function ProviderCard({ id }: { id: ProviderId }) {
  const spec = PROVIDERS[id];
  const saved = useStore((s) => s.keys[id]);
  const model = useStore((s) => s.settings.models[id]);
  const baseUrl = useStore((s) => s.settings.baseUrls[id]);
  const enabled = useStore((s) => s.settings.enabled[id]);
  const models = useStore((s) => s.settings.models);
  const baseUrls = useStore((s) => s.settings.baseUrls);
  const enabledMap = useStore((s) => s.settings.enabled);
  const patch = useStore((s) => s.patchSettings);
  const refreshKeys = useStore((s) => s.refreshKeys);
  const routed = useStore((s) => s.settings.useGateway && s.gatewayKey);
  const gatewayLabel = useStore((s) => gatewayPreset(s.settings.gatewayId).label);

  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const saveKey = async () => {
    if (!draftKey.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      await bridge.setApiKey(id, draftKey.trim());
      setDraftKey("");
      await refreshKeys();
      setNote("Saved to your account.");
    } catch (err) {
      setNote(String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    try {
      await bridge.deleteApiKey(id);
      await refreshKeys();
      setNote("Removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-card">
      <div className="top">
        <span className="dot" style={{ background: spec.accent }} />
        <span className="name">{spec.label}</span>
        <span className="vendor">{spec.vendor}</span>
        {/* What matters here is whether this pane can reach a model, not whether
            a particular credential exists. With the gateway on, a missing vendor
            key is not a problem to fix. */}
        {routed ? (
          <span className="badge" data-tone="good" title={`Routed through ${gatewayLabel}`}>
            via {gatewayLabel}
          </span>
        ) : saved ? (
          <span className="badge" data-tone="good">
            Direct
          </span>
        ) : (
          <span className="badge" data-tone="bad">
            No route
          </span>
        )}
        <span className="spacer" />
        <button
          className="switch"
          data-on={enabled}
          aria-label={`Toggle ${spec.vendor}`}
          onClick={() => patch({ enabled: { ...enabledMap, [id]: !enabled } })}
        />
      </div>

      <div className="row" data-dim={routed}>
        <label htmlFor={`key-${id}`}>API Key</label>
        <div className="with-btn">
          <input
            id={`key-${id}`}
            className="field mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={saved ? "••••••••  saved" : spec.keyHint}
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveKey();
            }}
          />
          <button className="btn" onClick={() => void saveKey()} disabled={busy || !draftKey.trim()}>
            Save
          </button>
          {saved && (
            <button className="btn ghost" onClick={() => void removeKey()} disabled={busy}>
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="row" data-dim={routed}>
        <label htmlFor={`model-${id}`}>Model</label>
        <select
          id={`model-${id}`}
          className="field mono"
          value={model}
          onChange={(e) => patch({ models: { ...models, [id]: e.target.value } })}
        >
          {spec.knownModels.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      <div className="row" data-dim={routed}>
        <label htmlFor={`base-${id}`}>Base URL</label>
        <input
          id={`base-${id}`}
          className="field mono"
          value={baseUrl}
          spellCheck={false}
          placeholder={spec.defaultBaseUrl}
          onChange={(e) => patch({ baseUrls: { ...baseUrls, [id]: e.target.value } })}
        />
      </div>

      <p className="hint">
        {note ? (
          note
        ) : routed ? (
          <>
            This pane uses {gatewayLabel}, so its key and model are inactive but preserved. Turn
            the gateway off to restore this pane&apos;s own credential.
          </>
        ) : (
          <>
            Keys are stored in your account and loaded by the desktop app.{" "}
            <button
              className="link"
              onClick={() => {
                void openUrl(spec.keyUrl).catch(() => window.open(spec.keyUrl, "_blank"));
              }}
            >
              Get a {spec.vendor} key
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** Read-only: Story Strip no longer has a separate extraction configuration. */
function ReadingCard() {
  const gatewayId = useStore(s => s.settings.gatewayId);
  const gatewayKey = useStore(s => s.gatewayKey);
  const probes = useStore(s => s.settings.probes);
  const enabled = useStore(s => s.settings.enabled);
  const availableVision = Object.values(probes).filter(p => p.ok && p.vision === true).length;
  const [refreshingDocs, setRefreshingDocs] = useState(false);
  const [docResults, setDocResults] = useState<LanguageRefreshResult[] | null>(null);
  const refreshDocs = async () => {
    setRefreshingDocs(true);
    try { setDocResults(await refreshOfficialLanguageSources()); }
    finally { setRefreshingDocs(false); }
  };
  return <div className="provider-card">
    <div className="top">
      <span className="name">Independent screenshot vision</span>
      <span className="spacer" />
      <span className="vendor">Direct images</span>
    </div>
    <p className="hint">
      Council Editor uses a fixed roster of ten models, regardless of which API gateway
      you select. Wiro, TokenRouter and Clean APIs only change the transport and
      exact model-ID spelling. No gateway is allowed to introduce an eleventh model.
    </p>
    <div className="row" style={{ alignItems: "center", gap: 12 }}>
      <span>Official language documentation</span>
      <button className="btn ghost" disabled={refreshingDocs} onClick={() => void refreshDocs()}>
        {refreshingDocs ? "Checking…" : "Refresh official docs"}
      </button>
    </div>
    {docResults && <p className="hint" role="status">
      {docResults.filter(result => result.ok).length}/{docResults.length} official sources reachable. The local Markdown packs remain the offline fallback.
    </p>}
    <p className="hint">
      Every selected AI agent sees the original images and independently determines the
      question and solution. There is no shared OCR or image extraction, no separate
      reading agents, and no text-only substitute for a screenshot.
    </p>
    <div className="row"><span>Selected API</span><b>{gatewayPreset(gatewayId).label}</b></div>
    <div className="row"><span>Gateway credential</span><b>{gatewayKey ? "Connected" : "Not connected"}</b></div>
    <div className="row"><span>Eligible configured models</span><b>{Object.values(enabled).filter(Boolean).length} / 10</b></div>
    <div className="row"><span>Models with observed vision support</span><b>{availableVision}</b></div>
    <p className="hint">
      Use the API tab to refresh this gateway&apos;s model catalogue and run a live
      image-capability check. Only verified vision-capable models receive screenshot
      bytes. The Big O knowledge library and Council test evidence guide solution
      analysis; runtime measurements are never presented as theoretical Big O.
    </p>
  </div>;
}

/** Navigation only: original setting panels and their persistence remain unchanged. */
const TABS = [
  { id: "overview", label: "Overview", icon: "overview", group: "Overview", detail: "Your workspace at a glance.", keywords: "home status quick start" },
  { id: "api", label: "Connections", icon: "connections", group: "Intelligence", detail: "API gateways, provider credentials and routing.", keywords: "api key gateway providers credentials models connection" },
  { id: "council", label: "AI Council", icon: "council", group: "Intelligence", detail: "Configure solvers, judges, synthesis and model health.", keywords: "agent solver judge model intelligence council" },
  { id: "reading", label: "Vision & Knowledge", icon: "vision", group: "Intelligence", detail: "Screenshot understanding and official language references.", keywords: "vision reading screenshots knowledge docs python cpp rust" },
  { id: "capture", label: "Capture & Overlay", icon: "capture", group: "Workspace", detail: "Background helper, capture behavior and shortcuts.", keywords: "screen helper hotkey keyboard overlay shortcut capture" },
  { id: "appearance", label: "Appearance", icon: "appearance", group: "Workspace", detail: "Choose the look of your workspace.", keywords: "theme dark light system display color" },
  { id: "limits", label: "Execution & Limits", icon: "limits", group: "Workspace", detail: "Request budgets, rate limits and cloud execution.", keywords: "e2b lab sandbox python rust cpp tokens limits rate quota execution" },
  { id: "sessions", label: "Account & Security", icon: "sessions", group: "Account", detail: "Secure account, storage and session preferences.", keywords: "account pin storage database timezone sessions security" },
  { id: "updates", label: "About & Updates", icon: "updates", group: "Account", detail: "Check for application releases and updates.", keywords: "version update about release download" },
] as const;

const SETTINGS_GROUPS = ["Overview", "Intelligence", "Workspace", "Account"] as const;


function AppearanceCard() {
  const theme = useStore((s) => s.settings.theme || "system");
  const patch = useStore((s) => s.patchSettings);

  const options: Array<{ id: "system" | "light" | "dark"; label: string; desc: string; icon: string }> = [
    {
      id: "system",
      label: "System Mode",
      desc: "Automatically follows macOS and system light / dark preferences.",
      icon: "💻",
    },
    {
      id: "light",
      label: "Light Mode",
      desc: "Bright daylight theme with high readability and crisp borders.",
      icon: "☀️",
    },
    {
      id: "dark",
      label: "Dark Mode",
      desc: "Deep contrast dark palette designed for low-light focus.",
      icon: "🌙",
    },
  ];

  return (
    <div className="provider-card">
      <div className="top">
        <span className="name">Appearance & Theme</span>
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        Choose a light, dark, or system-controlled theme.
      </p>

      <div className="theme-options-grid">
        {options.map((opt) => {
          const selected = theme === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              className="theme-option-card"
              data-selected={selected}
              onClick={() => patch({ theme: opt.id })}
            >
              <div className="theme-option-header">
                <span className="theme-option-icon">{opt.icon}</span>
                <span className="theme-option-title">{opt.label}</span>
                {selected && <span className="chip" style={{ marginLeft: "auto", fontSize: 10 }}>Active</span>}
              </div>
              <p className="theme-option-desc">{opt.desc}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UpdateCard() {
  const [result, setResult] = useState<bridge.UpdateCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await bridge.checkForUpdates());
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const openDownload = () => {
    const url = result?.downloadUrl || result?.releaseUrl;
    if (!url) return;
    void openUrl(url).catch(() => window.open(url, "_blank"));
  };

  return (
    <div className="provider-card">
      <div className="top">
        <span className="name">App updates</span>
        <span className="vendor">GitHub releases</span>
        <span className="spacer" />
        {result && (
          <span className="badge" data-tone={result.updateAvailable ? "warn" : "good"}>
            {result.updateAvailable ? "Update available" : "Up to date"}
          </span>
        )}
      </div>

      <div className="row">
        <label>Current</label>
        <span className="field mono" style={{ opacity: result ? 0.85 : 0.6 }}>
          {result?.currentVersion ?? (bridge.inTauri() ? "Check to read version" : "Desktop app required")}
        </span>
      </div>

      {result?.latestVersion && (
        <div className="row">
          <label>Latest</label>
          <span className="field mono" style={{ opacity: 0.85 }}>
            {result.latestVersion}
          </span>
        </div>
      )}

      {result?.publishedAt && (
        <div className="row">
          <label>Published</label>
          <span className="vendor">
            {new Date(result.publishedAt).toLocaleString()}
          </span>
        </div>
      )}

      <div className="actions">
        <button className="btn" onClick={() => void check()} disabled={busy || !bridge.inTauri()}>
          {busy ? "Checking..." : "Check for Updates"}
        </button>
        {result?.updateAvailable && (
          <button className="btn primary" onClick={openDownload}>
            Download Latest
          </button>
        )}
        {result?.releaseUrl && (
          <button
            className="btn ghost"
            onClick={() => void openUrl(result.releaseUrl!).catch(() => window.open(result.releaseUrl!, "_blank"))}
          >
            Open Release
          </button>
        )}
      </div>

      {result && !result.updateAvailable && (
        <p className="hint" style={{ color: "var(--good)" }}>
          You are running the latest published version.
        </p>
      )}
      {result?.updateAvailable && (
        <p className="hint">
          A newer release is ready. Download it, quit Council Editor, and install the new build.
          {result.downloadUrl ? " The download button opens the macOS installer asset." : " No installer asset was found, so the release page is used."}
        </p>
      )}
      {result?.notes && (
        <p className="hint" style={{ whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto" }}>
          {result.notes}
        </p>
      )}
      {error && (
        <p className="hint" style={{ color: "var(--bad)" }}>
          {error}
        </p>
      )}
      {!bridge.inTauri() && (
        <p className="hint">
          Update checks run from the desktop shell so the app can use its packaged version.
        </p>
      )}
    </div>
  );
}

/**
 * The Council card: one switch and two rosters.
 *
 * Kept deliberately flat — one free-text list for solvers, one for judges —
 * because a council that needs a configuration wizard will never be run. The
 * defaults are the ten-solver/five-judge bench from the design; anything that
 * goes wrong editing them degrades to the defaults rather than breaking the
 * run. Every seat rides the gateway: a council reachable only to accounts with
 * ten vendor keys is a council nobody convenes.
 */
function CouncilCard() {
  const settings = useStore((s) => s.settings);
  const gatewayKey = useStore((s) => s.gatewayKey);
  const patch = useStore((s) => s.patchSettings);
  const probes = useStore((st) => st.settings.probes);
  const probing = useStore((st) => st.probing);
  const probeError = useStore((st) => st.probeError);
  const testModels = useStore((st) => st.testModels);

  const [solversDraft, setSolversDraft] = useState<string | null>(null);
  const [judgesDraft, setJudgesDraft] = useState<string | null>(null);

  // What the key is entitled to, shared with the Session so two cards are not
  // each firing the same GET /v1/models behind the user's back.
  const [available, setAvailable] = useState<string[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const listModels = useCallback(async () => {
    setListing(true);
    setListError(null);
    try {
      setAvailable(primaryCatalog(await bridge.listGatewayModels(settings.gatewayBaseUrl, settings.gatewayId)));
    } catch (err) {
      setAvailable(null);
      setListError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setListing(false);
    }
  }, [settings.gatewayBaseUrl, settings.gatewayId]);

  const commitSolvers = () => {
    if (solversDraft === null) return;
    // One per line: an id alone uses the chat wire; an id tagged
    // `id/responses` (or `id/responses`) carries that endpoint override.
    // This is how codex enters the roster: it lives on the Responses API,
    // and writing it plainly would produce an "unsupported endpoint" probe
    // every time.
    const models = solversDraft
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.+?)\/(responses|chat)$/i);
        if (m) {
          return { id: m[1].trim(), endpoint: m[2].toLowerCase() as "chat" | "responses" };
        }
        return { id: line, endpoint: "chat" as const };
      })
      .filter((s) => s.id.length > 1);
    if (models.length >= 2) patch({ councilModels: models.slice(0, 10) });
    setSolversDraft(null);
  };

  const commitJudges = () => {
    if (judgesDraft === null) return;
    // One per line: `model/emphasis`, model alone, or `emphasis: model`.
    const seats = judgesDraft
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const slash = line.match(/^(.+?)\s*\/\s*(algorithms|correctness|performance|engineering|security)$/i);
        if (slash) return { model: slash[1], emphasis: slash[2].toLowerCase() as never };
        const colon = line.match(/^(algorithms|correctness|performance|engineering|security)\s*:\s*(.+)$/i);
        if (colon) return { model: colon[2], emphasis: colon[1].toLowerCase() as never };
        return { model: line, emphasis: "correctness" as never };
      })
      .filter((s) => s.model.length > 1);
    if (seats.length >= 1) patch({ councilJudges: seats.slice(0, 5) });
    setJudgesDraft(null);
  };

  const enabled = settings.councilEnabled;
  const reachable = settings.useGateway && gatewayKey;

  // The roster as it will actually sit: judges, synthesizer, harness writer.
  // Solvers shown are what the field will hold *as configured* — the pane's
  // own answers stand in for any declared model it already holds, at run time.
  const judges = settings.councilJudges.map((j) => j.model);
  const synthesis = settings.synthesisModel || settings.councilJudges[0]?.model || "";
  const councilModelsInUse = useMemo(() => {
    const ids = new Set<string>();
    for (const m of settings.councilModels) ids.add(m.id);
    for (const m of judges) ids.add(m);
    if (synthesis) ids.add(synthesis);
    return [...ids];
  }, [settings.councilModels, judges, synthesis]);

  const tested = councilModelsInUse.filter((m) => probes[m]).length;
  const working = councilModelsInUse.filter((m) => probes[m]?.ok).length;

  return (
    <div className="provider-card settings-council-card">
      <div className="top">
        <span className="dot" style={{ background: "var(--accent)" }} />
        <span className="name">Engineering council</span>
        <span className="vendor">Solvers · judges · synthesis</span>
        <span className="spacer" />
        <span className="badge" data-tone={enabled ? (reachable ? "good" : "warn") : undefined}>
          {enabled ? (reachable ? "armed" : "needs the gateway") : "off"}
        </span>
      </div>

      <div className="settings-form-section-heading"><span>Run preferences</span><small>Choose how Council responds</small></div>
      <div className="row">
        <label htmlFor="council-on">Convene on Run</label>
        <div className="segmented" style={{ flex: 1 }}>
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              data-on={enabled === v}
              style={{ flex: 1 }}
              onClick={() => patch({ councilEnabled: v })}
            >
              {v ? "Council" : "Panel Only"}
            </button>
          ))}
        </div>
      </div>
      <details className="settings-inline-help"><summary>How Council mode works</summary><p>The council re-solves the problem, tests each code candidate, reviews the results, and produces a final recommendation. Failed tests cannot win. Expect about 36 extra requests per run, so low gateway limits make council runs slower.</p></details>

      <div className="row">
        <label htmlFor="default-solution-language">Code in · primary language</label>
        <select
          id="default-solution-language"
          className="field mono"
          value={settings.outputLanguage || "Python"}
          onChange={(event) => patch({ outputLanguage: event.target.value })}
        >
          <option value="Python">Python</option>
          <option value="C++">C++</option>
          <option value="Rust">Rust</option>
        </select>
      </div>
      <p className="settings-form-caption">Python by default. This choice is saved before your next question is submitted, so all four solvers and E2B tests use that language first. C++ and Rust remain available as separately verified versions afterward. A question with an explicit judge language or code stub keeps its required interface.</p>

      <div className="row">
        <label htmlFor="memory-target">Memory goal</label>
        <input id="memory-target" className="field" type="number" min={1} max={1024}
          value={Math.round(settings.memoryTargetKb / 1024)}
          onChange={(event) => patch({ memoryTargetKb: Math.max(1, Number(event.target.value) || 1) * 1024 })}
          style={{ flex: 1 }} />
        <span className="vendor">MB (soft target)</span>
      </div>
      <details className="settings-inline-help"><summary>Memory goal details</summary><p>Correctness and Big-O complexity come first. A 0 ms display is rounded timing, and interpreter or platform overhead may exceed this memory goal.</p></details>

      <div className="row">
        <label htmlFor="council-include">Panel Answers Are Candidates</label>
        <div className="segmented" style={{ flex: 1 }}>
          {([true, false] as const).map((v) => (
            <button
              key={String(v)}
              data-on={settings.councilIncludePanel === v}
              style={{ flex: 1 }}
              onClick={() => patch({ councilIncludePanel: v })}
              title={
                v
                  ? "The pane answers join the field; declared models already in a pane are not asked twice"
                  : "Only the roster below solves — the panes run their usual comparison"
              }
            >
              {v ? "Included" : "Roster Only"}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-form-section-heading"><span>Execution</span><small>Isolated sandbox testing</small></div>
      <div className="row">
        <label htmlFor="execution-provider">Program Tests</label>
        <span className="chip">E2B Cloud only</span>
      </div>

      {(
        <>
          <div className="row">
            <label htmlFor="e2b-timeout">E2B Timeout</label>
            <input
              id="e2b-timeout"
              className="field"
              type="number"
              min={30}
              max={300}
              step={15}
              value={Math.round(settings.e2bTimeoutMs / 1000)}
              onChange={(e) => patch({ e2bTimeoutMs: Number(e.target.value) * 1000 })}
              style={{ flex: 1 }}
            />
            <span className="vendor">seconds</span>
          </div>
          <details className="settings-inline-help"><summary>E2B sandbox requirements</summary><p>Candidate tests run in isolated E2B Linux sandboxes. The worker requires an <code>E2B_API_KEY</code>. Only output, timing, memory, and sandbox ID are saved.</p></details>
        </>
      )}
      <div className="settings-form-section-heading"><span>Model roster</span><small>One model per line · changes save when you leave a field</small></div>
      <div className="row settings-roster-row">
        <label htmlFor="council-solvers" style={{ paddingTop: 6 }}>
          Solvers
        </label>
        <textarea
          id="council-solvers"
          className="field mono"
          rows={5}
          spellCheck={false}
          value={
            solversDraft ??
            settings.councilModels
              .map((m) => (m.endpoint && m.endpoint !== "chat" ? `${m.id}/${m.endpoint}` : m.id))
              .join("\n")
          }
          onChange={(e) => setSolversDraft(e.target.value)}
          onBlur={commitSolvers}
          style={{ flex: 1, resize: "vertical" }}
        />
      </div>
      <p className="settings-form-caption">2–10 model IDs · add <code>/responses</code> for Responses API.</p>

      <div className="row settings-roster-row">
        <label htmlFor="council-judges" style={{ paddingTop: 6 }}>
          Judges
        </label>
        <textarea
          id="council-judges"
          className="field mono"
          rows={4}
          spellCheck={false}
          value={
            judgesDraft ?? settings.councilJudges.map((j) => `${j.model}/${j.emphasis}`).join("\n")
          }
          onChange={(e) => setJudgesDraft(e.target.value)}
          onBlur={commitJudges}
          style={{ flex: 1, resize: "vertical" }}
        />
      </div>
      <p className="settings-form-caption">1–5 judge seats · <code>model/emphasis</code> per line.</p>

      <div className="row">
        <label htmlFor="council-synth">Synthesizer</label>
        <select
          id="council-synth"
          className="field mono"
          value={settings.synthesisModel}
          onChange={(e) => patch({ synthesisModel: e.target.value })}
          style={{ flex: 1 }}
        >
          {Array.from(new Set([settings.synthesisModel, ...SELECTABLE_PRIMARY_MODEL_IDS.map(id => preferredPrimaryRoute(id, settings.gatewayId))])).map(model =>
            <option key={model} value={model}>{model}</option>)}
        </select>
      </div>
      <details className="settings-inline-help"><summary>Model roster format</summary><p>Panel models are not requested twice. A solver may use <code>/responses</code> or <code>/chat</code>. Judges emphasize algorithms, correctness, performance, engineering or security. The synthesizer also writes the test harness and must be available on the selected gateway.</p></details>

      {reachable && (
        <>
          <div className="settings-form-section-heading"><span>Roster health</span><small>Gateway availability and live model probes</small></div>
          <div className="section-label" style={{ margin: "10px 0 6px", display: "flex", gap: 8, alignItems: "center" }}>
            <span>Roster health</span>
            <span className="spacer" />
            <button className="btn tiny ghost" onClick={() => void listModels()} disabled={listing}>
              {listing ? "Asking…" : available ? "Refresh List" : "Load the List"}
            </button>
            <button
              className="btn tiny"
              onClick={() => void testModels(councilModelsInUse, false)}
              disabled={probing}
              title="One small text call per roster model, through the governor"
            >
              {probing
                ? `Testing… ${tested}/${councilModelsInUse.length}`
                : `Test the roster (${councilModelsInUse.length})`}
            </button>
          </div>
          {listError && (
            <p className="hint" style={{ margin: "0 0 6px", color: "var(--bad)" }}>
              Could not read the model list: {listError}
            </p>
          )}
          {probeError && (
            <p className="hint" style={{ margin: "0 0 6px", color: "var(--bad)" }}>
              {probeError}
            </p>
          )}
          {available && (
            <p className="hint" style={{ margin: "0 0 6px" }}>
              {councilModelsInUse.filter((m) => available.includes(m)).length} of{" "}
              {councilModelsInUse.length} roster ids are on this key.
              {tested > 0 && (
                <>
                  {" "}{working} of {tested} probed answered.
                </>
              )}
            </p>
          )}

          {/* One row per roster model, the same truth badges the four panes
              get. A red "not on key" chip means the id was never listed by the
              router; a red "failed" chip means the probe was refused. The two
              look alike from the panel but mean entirely different fixes. */}
          {councilModelsInUse.map((m) => {
            const probe = probes[m];
            const onKey = available ? available.includes(m) : null;
            const roles = [
              settings.councilModels.some((x) => x.id === m) ? "solver" : null,
              settings.councilJudges.find((j) => j.model === m)?.emphasis ? `judge/${settings.councilJudges.find((j) => j.model === m)!.emphasis}` : null,
              synthesis === m ? "synthesis" : null,
            ].filter(Boolean);
            return (
              <div className="row settings-model-health-row" key={m}>
                <span className="field mono" style={{ opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {m}
                </span>
                <span style={{ fontSize: 10.5, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                  {roles.join(" · ")}
                </span>
                {onKey === false && (
                  <span className="badge" data-tone="bad" title="Not in the router's /models answer for this key — enable the model there or fix a typo here.">
                    not on key
                  </span>
                )}
                {probe && <ProbeBadge probe={probe} modelId={m} />}
              </div>
            );
          })}
          <details className="settings-inline-help"><summary>Understanding probe results</summary><p>“Not on key” means the router did not list the model. Enable it for this gateway, or correct its ID before running Council. Probe errors may instead mean timeouts or rate limits; inspect the exact badge reason.</p></details>
        </>
      )}
    </div>
  );
}

/**
 * The three global shortcuts, shown rather than edited.
 *
 * They are registered in Rust before the web view exists, so the web view is the
 * wrong place to change them; the environment variables are the honest escape
 * hatch until there is a Rust-side settings store to write to.
 */
const SHORTCUTS = [
  { keys: "\u2303\u2325S", what: "Capture the whole screen", env: "CODE_AUDITOR_SCREEN_KEY" },
  { keys: "\u2303\u2325R", what: "Capture a region", env: "CODE_AUDITOR_CAPTURE_KEY" },
  { keys: "\u2303\u2325\u21e7L", what: "Capture the left half of this app's display", env: "CODE_AUDITOR_CAPTURE_LEFT_KEY" },
  { keys: "\u2303\u2325\u21e7R", what: "Capture the right half of this app's display", env: "CODE_AUDITOR_CAPTURE_RIGHT_KEY" },
  { keys: "\u2303\u2325A", what: "Solve what is loaded", env: "CODE_AUDITOR_SOLVE_KEY" },
];

/** Capture behaviour and the shortcuts that trigger it. */
function CaptureCard() {
  const raise = useStore((s) => s.settings.raiseOnCapture);
  const maxImages = useStore((s) => s.settings.maxImages);
  const overlayMode = useStore((s) => s.settings.overlayMode);
  const mcqModel = useStore((s) => s.settings.mcqModel);
  const mcqEndpoint = useStore((s) => s.settings.mcqEndpoint);
  const availableModels = useStore((s) => s.settings.availableModels);
  const gatewayId = useStore((s) => s.settings.gatewayId);
  const patch = useStore((s) => s.patchSettings);
  const [helper, setHelper] = useState<bridge.BackgroundHelperStatus | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const [helperNote, setHelperNote] = useState<string | null>(null);

  const refreshHelper = useCallback(async () => {
    try {
      setHelper(await bridge.backgroundHelperStatus());
    } catch (err) {
      setHelperNote(String(err));
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refreshHelper());
  }, [refreshHelper]);

  const setInstalled = async (install: boolean) => {
    setHelperBusy(true);
    setHelperNote(null);
    try {
      const next = install
        ? await bridge.installBackgroundHelper()
        : await bridge.uninstallBackgroundHelper();
      setHelper(next);
      setHelperNote(
        install
          ? next.loaded
            ? "Installed and running. macOS will start it again at login."
            : next.problem || "The agent was written but launchd has not loaded it."
          : "Removed. Helper-owned background capture will stop after the helper exits."
      );
    } catch (err) {
      setHelperNote(String(err));
    } finally {
      setHelperBusy(false);
    }
  };

  return (
    <>
      <div className="provider-card">
        <div className="top">
          <span className="name">Background helper</span>
          <span className="spacer" />
          <span className="vendor">{helper?.installed ? "installed" : "not installed"}</span>
        </div>
        <p className="settings-form-caption">Manage background captures without opening the main window.</p>
        <details className="settings-inline-help">
          <summary>Permissions and capture sequence</summary>
          <p>The first digit chooses the workflow and the second the screenshot shape. The helper requires macOS Input Monitoring and Screen Recording permissions.</p>
        </details>
        <div className="row">
          <label>State</label>
          {/* "Installed" used to mean a file existed. It now means launchd has
              accepted the agent, which is the only version of the word worth
              showing someone. */}
          <span
            className="badge"
            data-tone={helper?.loaded ? "good" : helper?.installed ? "warn" : undefined}
          >
            {helper?.loaded ? "running" : helper?.installed ? "written, not loaded" : "not installed"}
          </span>
        </div>
        {helper?.problem && (
          <p className="hint" style={{ margin: "0 0 6px", color: "var(--bad)" }}>
            {helper.problem}
          </p>
        )}
        <div className="row">
          <label>LaunchAgent</label>
          <span className="mono small">{helper?.plistPath || "desktop shell required"}</span>
        </div>
        <div className="row">
          <label>Helper</label>
          <span className="mono small">{helper?.helperPath || "desktop shell required"}</span>
        </div>
        <div className="row">
          <label>App</label>
          <span className="mono small">{helper?.appPath || "desktop shell required"}</span>
        </div>
        <div className="actions">
          <button
            className="btn"
            disabled={helperBusy}
            onClick={() => void setInstalled(true)}
          >
            {helper?.loaded ? "Update & Restart" : helper?.installed ? "Reinstall" : "Install"}
          </button>
          <button
            className="btn ghost"
            disabled={helperBusy || helper?.installed !== true}
            onClick={() => void setInstalled(false)}
          >
            Remove
          </button>
          <button className="btn ghost" disabled={helperBusy} onClick={() => void refreshHelper()}>
            Refresh
          </button>
        </div>
        {helperNote && <p className="hint">{helperNote}</p>}
        <HelperCard embedded />
      </div>

      <div className="provider-card">
        <div className="top">
          <span className="name">Overlay screens</span>
          <span className="spacer" />
          <span className="vendor">Coding + MCQ</span>
        </div>
        <div className="segmented" style={{ marginBottom: 10 }}>
          {(["auto", "coding", "mcq"] as const).map((mode) => (
            <button
              key={mode}
              data-on={overlayMode === mode}
              onClick={() => patch({ overlayMode: mode })}
              type="button"
            >
              {mode === "auto" ? "Auto" : mode === "coding" ? "Coding" : "MCQ"}
            </button>
          ))}
        </div>
        <details className="settings-inline-help">
          <summary>How automatic overlay mode works</summary>
          <p>Auto switches to MCQ when the captured text contains answer choices. Force MCQ to handle the next capture as a multiple-choice question.</p>
        </details>
        <div className="row">
          <label htmlFor="mcq-model">MCQ Model</label>
          <select
            id="mcq-model"
            className="field mono"
            value={mcqModel}
            onChange={(e) => patch({ mcqModel: e.target.value })}
          >
            {Array.from(new Set([mcqModel, ...(availableModels.length ? availableModels : SELECTABLE_PRIMARY_MODEL_IDS.map(id => preferredPrimaryRoute(id, gatewayId)))])).map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        </div>
        <div className="row">
          <label htmlFor="mcq-endpoint">MCQ API</label>
          <select
            id="mcq-endpoint"
            className="field"
            value={mcqEndpoint}
            onChange={(e) => patch({ mcqEndpoint: e.target.value as never })}
          >
            <option value="auto">Auto Route</option>
            <option value="chat">Chat Completions</option>
            <option value="responses">Responses API</option>
          </select>
        </div>
      </div>

      <div className="provider-card">
        <div className="top">
          <span className="name">After a capture</span>
          <span className="spacer" />
          <button
            className="switch"
            data-on={raise}
            aria-label="Bring the app forward after a capture"
            onClick={() => patch({ raiseOnCapture: !raise })}
          />
        </div>
        <p className="settings-form-caption">
          {raise ? "Bring the application forward after capturing." : "Keep the application in the background after capturing."}
        </p>
      </div>

      <div className="provider-card">
        <div className="top">
          <span className="name">Images per run</span>
        </div>
        <div className="row">
          <label htmlFor="maximg">Keep at Most</label>
          <input
            id="maximg"
            className="field mono"
            type="number"
            min={1}
            max={MAX_IMAGES}
            step={1}
            value={maxImages}
            onChange={(e) => patch({ maxImages: Number(e.target.value) })}
          />
        </div>
        <details className="settings-inline-help">
          <summary>Image limits and saved captures</summary>
          <p>Each image goes to enabled agents: {maxImages} {maxImages === 1 ? "image" : "images"} may mean up to {maxImages * 5} uploads. Captures also remain in <code>~/Library/Application Support/.com.apple.mds/cache/captures</code>; lowering the limit never deletes them.</p>
        </details>
      </div>

      <div className="provider-card">
        <div className="top">
          <span className="name">Shortcuts</span>
          <span className="spacer" />
          <span className="vendor">System-wide</span>
        </div>
        {SHORTCUTS.map((s) => (
          <div className="row" key={s.env}>
            <label>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{s.keys}</span>
            </label>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{s.what}</span>
          </div>
        ))}
        {[
          { keys: "10 · 11 · 12", route: "Main app: full screen · left · right" },
          { keys: "21 · 22 · 23 · 24", route: "Background coding: full screen · left · right · region" },
          { keys: "31 · 32 · 33 · 34", route: "Background MCQ: full screen · left · right · region" },
          { keys: "13", route: "Main app: process captured image(s) with enabled models" },
          { keys: "25", route: "Background coding: submit captured images for processing" },
          { keys: "35", route: "Background MCQ: submit captured images for processing" },
        ].map((route) => (
          <div className="row" key={route.keys}>
            <label><span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{route.keys}</span></label>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{route.route}</span>
          </div>
        ))}
        <details className="settings-inline-help">
          <summary>Using and customizing shortcuts</summary>
          <p>Enter two-digit codes quickly. Capture codes stage images; 13, 25 and 35 submit staged images. The Rust helper works with the app closed. Configure regular shortcut environment variables before launch, such as <code>CODE_AUDITOR_SOLVE_KEY="Control+Alt+J"</code>. Conflicts with other apps can prevent a shortcut from working.</p>
        </details>
      </div>
    </>
  );
}

export default function SettingsDialog() {
  // Navigation redesign only. The existing settings cards and their PIN gates,
  // persistence, capture hooks, and server integration remain untouched.
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("overview");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const maxTokens = useStore((s) => s.settings.maxTokens);
  const patch = useStore((s) => s.patchSettings);
  const gatewayId = useStore((s) => s.settings.gatewayId);
  const gatewayKey = useStore((s) => s.gatewayKey);
  const councilEnabled = useStore((s) => s.settings.councilEnabled);
  const councilModelCount = useStore((s) => s.settings.councilModels.length);
  const theme = useStore((s) => s.settings.theme);
  const activeSection = TABS.find((item) => item.id === tab) ?? TABS[0];
  const normalizedSearch = search.toLocaleLowerCase().trim();
  const visibleSections = TABS.filter((item) =>
    !normalizedSearch || `${item.label} ${item.detail} ${item.keywords}`.toLocaleLowerCase().includes(normalizedSearch)
  );

  // Held as text while the field is being edited. Committing on every keystroke
  // meant clearing the box snapped it back to the default, so there was no way
  // to type a new number over the old one.
  const [tokenDraft, setTokenDraft] = useState<string | null>(null);
  const commitTokens = () => {
    if (tokenDraft !== null && tokenDraft.trim()) patch({ maxTokens: Number(tokenDraft) });
    setTokenDraft(null);
  };

  const perMinute = useStore((st) => st.settings.gatewayPerMinute);
  const selectedGatewayId = useStore((st) => st.settings.gatewayId);
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const commitRate = () => {
    if (rateDraft !== null && rateDraft.trim()) patch({ gatewayPerMinute: Number(rateDraft) });
    setRateDraft(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    // A settings section should open at its heading, not inherit the scroll
    // position of the previously selected long form.
    contentRef.current?.scrollTo(0, 0);
  }, [tab]);

  if (!open) return null;

  return (
    <div className="scrim settings-scrim" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal settings-workspace" role="dialog" aria-modal="true" aria-labelledby="settings-workspace-title">
        <header className="settings-workspace-header">
          <div className="settings-workspace-mark" aria-hidden="true">
            <SettingsGlyph name="overview" size={21} />
          </div>
          <div className="settings-workspace-heading">
            <h2 id="settings-workspace-title">Settings</h2>
            <span>Personalize your Council Editor workspace</span>
          </div>
          <span className="spacer" />
          <button className="settings-icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close settings" title="Close settings">
            <SettingsGlyph name="close" size={17} />
          </button>
        </header>

        <div className="settings-workspace-layout">
          <aside className="settings-workspace-sidebar" aria-label="Settings navigation">
            <label className="settings-workspace-search">
              <SettingsGlyph name="search" size={16} />
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
                autoComplete="off"
              />
              <kbd>⌘ F</kbd>
            </label>
            <nav className="settings-workspace-nav" aria-label="Settings sections">
              {SETTINGS_GROUPS.map((group) => {
                const items = visibleSections.filter((item) => item.group === group);
                if (!items.length) return null;
                return (
                  <div className="settings-workspace-nav-group" key={group}>
                    <div className="settings-workspace-nav-heading">{group}</div>
                    {items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="settings-workspace-nav-item"
                        data-selected={tab === item.id}
                        aria-current={tab === item.id ? "page" : undefined}
                        onClick={() => { setTab(item.id); setSearch(""); }}
                      >
                        <SettingsGlyph name={item.icon} size={17} />
                        <span>{item.label}</span>
                        {tab === item.id && <SettingsGlyph name="chevron" size={13} />}
                      </button>
                    ))}
                  </div>
                );
              })}
              {visibleSections.length === 0 && (
                <p className="settings-workspace-no-results">No matching settings. Try “models”, “capture” or “security”.</p>
              )}
            </nav>
            <div className="settings-sidebar-bottom">
              <SettingsGlyph name="shield" size={15} />
              <span>Sensitive changes require PIN verification</span>
            </div>
          </aside>

          <main ref={contentRef} className="content settings-workspace-content" id="settings-workspace-panel">
            <div className="settings-workspace-section-heading">
              <div className="settings-workspace-section-caption">COUNCIL EDITOR / PREFERENCES</div>
              <h3>{activeSection.label}</h3>
              <p>{activeSection.detail}</p>
            </div>

            {tab === "overview" && (
              <div className="settings-overview">
                <div className="settings-overview-hero">
                  <div className="settings-overview-hero-orb" aria-hidden="true"><SettingsGlyph name="council" size={27} /></div>
                  <div>
                    <span className="settings-overview-eyebrow">YOUR WORKSPACE</span>
                    <h4>Everything, in its place.</h4>
                    <p>Keep your intelligence engine, capture workflows, and preferences organized without changing how Council Editor works.</p>
                  </div>
                </div>
                <div className="settings-overview-metrics">
                  <button type="button" onClick={() => setTab("api")}>
                    <span className="settings-overview-metric-label"><SettingsGlyph name="connections" size={15} /> Gateway</span>
                    <strong>{gatewayPreset(gatewayId).label}</strong>
                    <span>{gatewayKey ? "Credential present" : "Credential not configured"}</span>
                  </button>
                  <button type="button" onClick={() => setTab("council")}>
                    <span className="settings-overview-metric-label"><SettingsGlyph name="council" size={15} /> AI Council</span>
                    <strong>{councilModelCount} model{councilModelCount === 1 ? "" : "s"}</strong>
                    <span>{councilEnabled ? "Enabled in preferences" : "Disabled in preferences"}</span>
                  </button>
                  <button type="button" onClick={() => setTab("appearance")}>
                    <span className="settings-overview-metric-label"><SettingsGlyph name="appearance" size={15} /> Appearance</span>
                    <strong>{theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System"}</strong>
                    <span>Current theme preference</span>
                  </button>
                </div>
                <div className="settings-overview-links">
                  <div className="settings-overview-links-heading">Quick access</div>
                  {([
                    { id: "council", label: "AI Engine", description: "Models, solvers, judges and synthesis", icon: "council" },
                    { id: "limits", label: "E2B Execution & Limits", description: "Cloud laboratory and run budgets", icon: "cloud" },
                    { id: "capture", label: "Capture & Overlay", description: "Helper state, screen controls and shortcuts", icon: "capture" },
                    { id: "sessions", label: "Account & Security", description: "PIN-protected account and storage", icon: "shield" },
                  ] as const).map((item) => (
                    <button key={item.id} type="button" onClick={() => setTab(item.id)} className="settings-overview-link">
                      <span className="settings-overview-link-icon"><SettingsGlyph name={item.icon} size={19} /></span>
                      <span className="settings-overview-link-copy">
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                      <SettingsGlyph name="chevron" size={15} />
                    </button>
                  ))}
                </div>
              </div>
            )}

          {tab === "api" && (
            <>
              <SensitiveSettingsGate
                title="Unlock API settings"
                detail="Confirm your PIN before adding, removing, or changing API keys."
              >
                <GatewayCard />
                {PROVIDER_ORDER.map((p) => (
                  <ProviderCard key={p} id={p} />
                ))}
              </SensitiveSettingsGate>
              <CodingSettingsCard />
            </>
          )}

          {tab === "council" && <CouncilCard />}

          {tab === "appearance" && <AppearanceCard />}

          {tab === "updates" && <UpdateCard />}

          {tab === "reading" && <ReadingCard />}

          {tab === "capture" && <CaptureCard />}

          {tab === "sessions" && (
            <>
              {/* The account lives in the database, so it belongs on the tab
                  where the database does rather than in a tab of its own. */}
              <SensitiveSettingsGate
                title="Unlock account settings"
                detail="Confirm your PIN before changing the account PIN or storage credentials."
              >
                <AccountCard />
                <StorageCard />
              </SensitiveSettingsGate>
              <TimeZoneCard />
            </>
          )}

          {tab === "limits" && (
          <div className="provider-card">
            <div className="top">
              <span className="name">Run Limits</span>
            </div>
            <div className="row">
              <label htmlFor="maxtok">Max Tokens</label>
              <input
                id="maxtok"
                className="field mono"
                type="number"
                min={MAX_TOKENS_RANGE.min}
                max={MAX_TOKENS_RANGE.max}
                step={512}
                value={tokenDraft ?? maxTokens}
                onChange={(e) => setTokenDraft(e.target.value)}
                onBlur={commitTokens}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTokens();
                }}
              />
            </div>
            <p className="hint">
              Applies to each agent and run. Reasoning models use part of this budget to think.
              Allowed range: {MAX_TOKENS_RANGE.min}–{MAX_TOKENS_RANGE.max}.
            </p>

            {/* The number that decides whether a run answers or 429s. It is a
                property of the plan, not of the API, so it cannot be discovered
                — only told to us, or learned the hard way from a refusal. */}
            {selectedGatewayId !== "cleanapis" ? <><div className="row" style={{ marginTop: 12 }}>
              <label htmlFor="rate">Gateway Requests per Minute</label>
              <input
                id="rate"
                className="field mono"
                type="number"
                min={1}
                max={600}
                step={1}
                value={rateDraft ?? perMinute}
                onChange={(e) => setRateDraft(e.target.value)}
                onBlur={commitRate}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRate();
                }}
              />
            </div>
            <p className="hint">
              Solver and Council requests use this rate. Extra requests queue instead of
              failing with <span className="mono">429 Too Many Requests</span>, so runs may take
              longer. TokenRouter&rsquo;s free tier allows 5 requests per minute.
            </p></> : <p className="hint">
              Clean API runs the selected solvers in parallel and follows the quota and retry
              delay returned by your Clean API plan.
            </p>}
          </div>
          )}

            {tab === "limits" && (
              <div className="settings-laboratory-notice">
                <span className="settings-overview-link-icon"><SettingsGlyph name="cloud" size={20} /></span>
                <div>
                  <strong>E2B Laboratory</strong>
                  <p>Python, Rust and C++ verification runs in cloud sandboxes. Sandbox templates, standby capacity and port recovery are server-managed; this page does not claim a live connection or expose credentials.</p>
                </div>
                <span className="settings-laboratory-mode">Server-managed</span>
              </div>
            )}
          </main>
        </div>

        <footer className="settings-workspace-footer">
          <span>Changes are applied when you edit them. Protected settings still require your PIN.</span>
          <span className="spacer" />
          <button className="btn primary" type="button" onClick={() => setOpen(false)}>Done</button>
        </footer>
      </div>
    </div>
  );
}
