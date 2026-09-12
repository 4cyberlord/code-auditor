"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ALL_AGENTS,
  EXTRA_AGENTS,
  FREE_ROUTER_MODELS,
  GATEWAY,
  agentSpec,
  PROVIDERS,
  PROVIDER_ORDER,
  VISION_PROVIDERS,
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
  const saved = useStore((s) => s.storageKey);
  const refreshKeys = useStore((s) => s.refreshKeys);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      await bridge.setApiKey(STORAGE.id, draft.trim());
      setDraft("");
      await refreshKeys();
      setNote("Saved. Screenshots go to the project now, and the local file is deleted.");
    } catch (err) {
      setNote(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await bridge.deleteApiKey(STORAGE.id);
      await refreshKeys();
      setNote("Removed. Screenshots stay on this machine again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-card">
      <div className="top">
        <span className="dot" style={{ background: STORAGE.accent }} />
        <span className="name">{STORAGE.label}</span>
        <span className="vendor">Where screenshots live</span>
        {saved ? (
          <span className="badge" data-tone="good">
            Uploading
          </span>
        ) : (
          <span className="badge" data-tone="warn">
            No key
          </span>
        )}
        <span className="spacer" />
        <a className="btn tiny ghost" href={STORAGE.keyUrl} target="_blank" rel="noreferrer">
          Get the key
        </a>
      </div>

      {/* Label first, then the field and its buttons inside `.with-btn`. `.row` is
          a two-column grid sized for a label, so an input placed directly in it
          takes the 92px label column and the button takes the rest — which is
          exactly backwards, and is what this looked like before. */}
      <div className="row">
        <label htmlFor="storage-key">Service key</label>
        <div className="with-btn">
          <input
            id="storage-key"
            className="field mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={saved ? "••••••••  saved" : STORAGE.keyHint}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
          />
          <button className="btn tiny" onClick={() => void save()} disabled={busy || !draft.trim()}>
            Save
          </button>
          {saved && (
            <button className="btn tiny ghost" onClick={() => void remove()} disabled={busy}>
              Remove
            </button>
          )}
        </div>
      </div>

      <p className="hint">
        Screenshots go to the private <span className="mono">{STORAGE.bucket}</span> bucket in
        your Supabase project, then are deleted from this Mac. This lets sessions open on another
        device. You need {STORAGE.requires}; the project URL comes from your database connection.
      </p>

      {note && (
        <p className="hint" style={{ color: "var(--text)" }}>
          {note}
        </p>
      )}
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
  return !!route && ["openai", "moonshot", "tokenrouter"].includes(route.provider);
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
        const endpoint = route ? endpointForCouncilModel(settings.councilModels, route.model) : "chat";
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
          {selected?.reason ?? "No supported model"}
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
          {!selected && <option value="">No supported model</option>}
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
        <label htmlFor="coding-project-name">Project name</label>
        <input
          id="coding-project-name"
          className="field"
          value={settings.codingProjectName}
          placeholder={projectNameFromPath(settings.codingProjectRoot) || "My app"}
          onChange={(e) => patch({ codingProjectName: e.target.value })}
        />
      </div>

      <div className="row">
        <label htmlFor="coding-project-root">Project folder</label>
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
        <label htmlFor="coding-tokens">Run limits</label>
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
  const baseUrl = useStore((s) => s.settings.gatewayBaseUrl);
  const routerModels = useStore((s) => s.settings.routerModels);
  const patch = useStore((s) => s.patchSettings);
  const refreshKeys = useStore((s) => s.refreshKeys);

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // What the router says this key can actually reach. Null until asked, because
  // "we have not looked" and "there is nothing there" have to read differently.
  const probes = useStore((st) => st.settings.probes);
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

  // Panes, the judge, both readers, and the council roster — everything the
  // app will actually ask for, not just the four panes. Testing the router's
  // whole catalogue would be slower, cost more, and tell you about models
  // nothing here uses; but testing *less* than the council asks for is how a
  // typo in a roster becomes a failed seat forty minutes into a run.
  const modelsInUse = useMemo(() => {
    const ids = new Set<string>();
    for (const p of PROVIDER_ORDER) ids.add(routerModels[p] || PROVIDERS[p].defaultRouterModel);
    for (const e of EXTRA_AGENTS) ids.add(e.model);
    ids.add(routerModels[judgeProvider] || PROVIDERS[judgeProvider].defaultRouterModel);
    for (const x of extractors) {
      ids.add(routerModels[x] || PROVIDERS[x].defaultRouterModel);
    }
    if (councilEnabled) {
      for (const m of councilModels) ids.add(m.id);
      for (const j of councilJudges) ids.add(j.model);
      if (synthesisModel.trim()) ids.add(synthesisModel.trim());
    }
    return [...ids].filter(Boolean);
  }, [routerModels, judgeProvider, extractors, councilEnabled, councilModels, councilJudges, synthesisModel]);

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
    for (const e of EXTRA_AGENTS) if (e.model === m) roles.push(e.label.toLowerCase());
    const judgeId = routerModels[judgeProvider] || PROVIDERS[judgeProvider].defaultRouterModel;
    if (judgeId === m) roles.push("judge");
    for (const x of extractors) {
      const id = routerModels[x] || PROVIDERS[x].defaultRouterModel;
      if (id === m) roles.push("reader");
    }
    if (councilEnabled) {
      if (councilModels.some((x) => x.id === m)) roles.push("solver");
      const seat = councilJudges.find((j) => j.model === m);
      if (seat) roles.push(`judge/${seat.emphasis}`);
      if (synthesisModel.trim() === m) roles.push("synthesis");
    }
    return roles;
  };

  // How far the image check has got, and how many seats came back able to read
  // one. Derived, so it clears itself the moment the seats change.
  const tested = modelsInUse.filter((m) => probes[m]).length;
  const working = modelsInUse.filter((m) => probes[m]?.ok).length;

  const refreshModels = useCallback(async () => {
    setListing(true);
    setListError(null);
    try {
      const ids = await bridge.listGatewayModels(baseUrl);
      setAvailable(ids);
      // Kept in settings, not just in this component's state: the Council reads
      // it before a run to skip seats this key cannot reach, and Settings is not
      // open when a run starts.
      patch({ availableModels: ids });
    } catch (err) {
      setAvailable(null);
      setListError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setListing(false);
    }
  }, [baseUrl, patch]);

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
      await bridge.setApiKey(GATEWAY.id, draft.trim());
      setDraft("");
      await refreshKeys();
      // A different key is a different catalogue. Dropping what we knew makes
      // the effect ask again, rather than leaving the previous key's list on
      // screen looking like an answer about this one.
      setAvailable(null);
      setListError(null);
      setNote("Saved. Every pane now routes through " + GATEWAY.label + ".");
    } catch (err) {
      setNote(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await bridge.deleteApiKey(GATEWAY.id);
      await refreshKeys();
      setAvailable(null);
      setListError(null);
      setNote("Removed. Each pane now needs its own vendor key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-card" data-accent="gateway">
      <div className="top">
        <span className="dot" style={{ background: GATEWAY.accent }} />
        <span className="name">{GATEWAY.label}</span>
        <span className="vendor">one key, every model</span>
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
          aria-label="Route through TokenRouter"
          onClick={() => patch({ useGateway: !on })}
        />
      </div>

      <div className="row">
        <label htmlFor="gw-key">API key</label>
        <div className="with-btn">
          <input
            id="gw-key"
            className="field mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={saved ? "••••••••  saved" : GATEWAY.keyHint}
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

      <div className="row">
        <label htmlFor="gw-base">Base URL</label>
        <input
          id="gw-base"
          className="field mono"
          value={baseUrl}
          spellCheck={false}
          placeholder={GATEWAY.defaultBaseUrl}
          onChange={(e) => patch({ gatewayBaseUrl: e.target.value })}
        />
      </div>

      {active && (
        <>
          <div
            className="section-label"
            style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}
          >
            <span>Everything this key can reach</span>
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
              {listing ? "Asking…" : "Refresh list"}
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
              onClick={() => void testModels(modelsInUse, true)}
              disabled={probing}
              title="Sends one image to each seat in use, at the governor's pace. Listing cannot tell you this."
            >
              {probing ? `${tested}/${modelsInUse.length}` : "Check which can read images"}
            </button>
          </div>

          {probeError && (
            <p className="hint" style={{ margin: "0 0 6px", color: "var(--bad)" }}>
              {probeError}
            </p>
          )}

          {tested > 0 && (
            <p className="hint" style={{ margin: "0 0 6px" }}>
              {working} of {tested} answered.{" "}
              {working < tested && (
                <>
                  The rest are marked below.{" "}
                  <b>Hover a failed badge to see the exact error TokenRouter returned</b>{" "}
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
                      {probe?.vision != null && (
                        <span className="badge" data-tone={probe.vision ? "good" : "warn"} title={probe.visionNote ?? ""}>
                          {probe.vision ? "sees images" : "text only"}
                        </span>
                      )}
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

          {/* The free panes have fixed ids, so they get a result line rather
              than an editable field. */}
          {EXTRA_AGENTS.map((e) => {
            const probe = probes[e.model];
            return (
              <div className="row" key={e.id}>
                <label>{e.label}</label>
                <span className="field mono" style={{ opacity: 0.7 }}>
                  {e.model}
                </span>
                {probe && <ProbeBadge probe={probe} modelId={e.model} />}
                {probe?.vision != null && (
                  <span
                    className="badge"
                    data-tone={probe.vision ? "good" : "warn"}
                    title={probe.visionNote ?? ""}
                  >
                    {probe.vision ? "sees images" : "text only"}
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}

      {active && (
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
            void openUrl(GATEWAY.modelsUrl).catch(() => window.open(GATEWAY.modelsUrl, "_blank"));
          }}
        >
          Browse the model list
        </button>
      </p>
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
      setNote("Saved to your Keychain.");
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
          <span className="badge" data-tone="good" title={`Routed through ${GATEWAY.label}`}>
            via {GATEWAY.label}
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
        <label htmlFor={`key-${id}`}>API key</label>
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
        <input
          id={`model-${id}`}
          className="field mono"
          list={`models-${id}`}
          value={model}
          spellCheck={false}
          onChange={(e) => patch({ models: { ...models, [id]: e.target.value } })}
        />
        <datalist id={`models-${id}`}>
          {spec.knownModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
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
            This pane uses {GATEWAY.label}, so its key and model are inactive but preserved. Turn
            the gateway off to restore this pane&apos;s own credential.
          </>
        ) : (
          <>
            Keys are stored in the macOS Keychain and read only by the app.{" "}
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

const CONTEXT_MODES = [
  {
    id: "auto" as const,
    label: "Auto",
    blurb:
      "Each pane gets what it can use. Vision models see the screenshot; text-only models get a transcription only when needed. No extra setup or unnecessary reading pass.",
  },
  {
    id: "images" as const,
    label: "Images",
    blurb:
      "Every agent gets the screenshot and reads it itself. No shared transcription, so no shared misreading — this is the safest option and the default.",
  },
  {
    id: "extract" as const,
    label: "Reading",
    blurb:
      "Two vision models transcribe and compare the screenshot. Other agents use the agreed text, so text-only models can join. This adds two calls and can spread a transcription mistake.",
  },
  {
    id: "both" as const,
    label: "Both",
    blurb:
      "The screenshot and the reading. The most expensive and the most thorough: an agent that can see gets to catch the transcription being wrong.",
  },
];

/** How the screenshot reaches the agents, and who reads it. */
function ReadingCard() {
  const contextMode = useStore((s) => s.settings.contextMode);
  const extractors = useStore((s) => s.settings.extractors);
  const keys = useStore((s) => s.keys);
  const patch = useStore((s) => s.patchSettings);

  const mode = CONTEXT_MODES.find((m) => m.id === contextMode) ?? CONTEXT_MODES[0];

  // Replacing one half of the pair. Picking the provider the other half already
  // uses would collapse the cross-check into one model agreeing with itself, so
  // the two swap places instead of colliding.
  const setExtractor = (slot: 0 | 1, next: ProviderId) => {
    const other = extractors[slot === 0 ? 1 : 0];
    const pair: ProviderId[] = slot === 0 ? [next, other] : [other, next];
    if (next === other) pair[slot === 0 ? 1 : 0] = extractors[slot];
    patch({ extractors: pair });
  };

  const missing = extractors.filter((p) => !keys[p]);

  return (
    <div className="provider-card">
      <div className="top">
        <span className="name">Reading the screenshot</span>
        <span className="spacer" />
        <span className="vendor">section 9</span>
      </div>

      <div className="segmented" style={{ marginBottom: 8 }}>
        {CONTEXT_MODES.map((m) => (
          <button
            key={m.id}
            data-on={contextMode === m.id}
            style={{ flex: 1 }}
            onClick={() => patch({ contextMode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>

      <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
        {mode.blurb}
      </p>

      {contextMode !== "images" && (
        <>
          {([0, 1] as const).map((slot) => (
            <div className="row" key={slot}>
              <label htmlFor={`extractor-${slot}`}>{slot === 0 ? "Reader" : "Checked by"}</label>
              <select
                id={`extractor-${slot}`}
                className="field"
                value={extractors[slot]}
                onChange={(e) => setExtractor(slot, e.target.value as ProviderId)}
              >
                {VISION_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDERS[p].label} — {PROVIDERS[p].vendor}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <p className="hint">
            Two different vendors is the point: a blind spot one model has, the other
            probably does not. When they disagree on the code or the error, the run says so
            instead of quietly picking one.
            {missing.length > 0 && (
              <>
                {" "}
                <b>No key saved for {missing.map((p) => PROVIDERS[p].vendor).join(" or ")}</b>
                {missing.length === extractors.length
                  ? " — reading cannot run, so runs fall back to sending the images."
                  : " — only one model will read, and nothing will check it."}
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

const TABS = [
  { id: "models" as const, label: "Models" },
  { id: "council" as const, label: "Council" },
  { id: "appearance" as const, label: "Appearance" },
  { id: "reading" as const, label: "Reading" },
  { id: "capture" as const, label: "Capture" },
  { id: "sessions" as const, label: "Sessions" },
  { id: "limits" as const, label: "Limits" },
];

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
      setAvailable(await bridge.listGatewayModels(settings.gatewayBaseUrl));
    } catch (err) {
      setAvailable(null);
      setListError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setListing(false);
    }
  }, [settings.gatewayBaseUrl]);

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
    <div className="provider-card">
      <div className="top">
        <span className="dot" style={{ background: "var(--accent)" }} />
        <span className="name">Engineering council</span>
        <span className="vendor">solve · execute · review · revise · judge · synthesize</span>
        <span className="spacer" />
        <span className="badge" data-tone={enabled ? (reachable ? "good" : "warn") : undefined}>
          {enabled ? (reachable ? "armed" : "needs the gateway") : "off"}
        </span>
      </div>

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
              {v ? "Council" : "Panel only"}
            </button>
          ))}
        </div>
      </div>
      <p className="hint">
        The council re-solves the problem, tests each code candidate, reviews the results, and
        produces a final recommendation. Failed tests cannot win. Expect about 36 extra requests
        per run, so low gateway limits make council runs slower.
      </p>

      <div className="row">
        <label htmlFor="council-include">Panel answers are candidates</label>
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
              {v ? "Included" : "Roster only"}
            </button>
          ))}
        </div>
      </div>

      <div className="row">
        <label htmlFor="execution-provider">Program tests</label>
        <div className="segmented" style={{ flex: 1 }}>
          {(["e2b", "local"] as const).map((v) => (
            <button
              key={String(v)}
              data-on={settings.executionProvider === v}
              style={{ flex: 1 }}
              onClick={() => patch({ executionProvider: v })}
            >
              {v === "e2b" ? "E2B sandbox" : "Local"}
            </button>
          ))}
        </div>
      </div>

      {settings.executionProvider === "e2b" && (
        <>
          <div className="row">
            <label htmlFor="e2b-timeout">E2B timeout</label>
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
          <p className="hint">
            Runs candidate tests in isolated E2B Linux sandboxes. The worker needs{" "}
            <span className="mono">E2B_API_KEY</span>. Only output, timing, memory, and the
            sandbox ID are saved.
          </p>
        </>
      )}

      <div className="row">
        <label htmlFor="benchmark-backend">Remote benchmark</label>
        <div className="segmented" style={{ flex: 1 }}>
          {(["actions", "off"] as const).map((v) => (
            <button
              key={String(v)}
              data-on={settings.benchmarkBackend === v}
              style={{ flex: 1 }}
              onClick={() => patch({ benchmarkBackend: v })}
            >
              {v === "actions" ? "GitHub Actions" : "Off"}
            </button>
          ))}
        </div>
      </div>

      {settings.benchmarkBackend === "actions" && (
        <>
          <div className="row">
            <label htmlFor="github-repository">Repository</label>
            <input
              id="github-repository"
              className="field mono"
              type="text"
              spellCheck={false}
              value={settings.githubRepository}
              onChange={(e) => patch({ githubRepository: e.target.value })}
              placeholder="owner/repo"
              style={{ flex: 1 }}
            />
          </div>
          <div className="row">
            <label htmlFor="github-workflow">Workflow</label>
            <input
              id="github-workflow"
              className="field mono"
              type="text"
              spellCheck={false}
              value={settings.githubWorkflow}
              onChange={(e) => patch({ githubWorkflow: e.target.value })}
              placeholder="cloud-benchmark.yml"
              style={{ flex: 1 }}
            />
          </div>
          <div className="row">
            <label htmlFor="github-ref">Ref</label>
            <input
              id="github-ref"
              className="field mono"
              type="text"
              spellCheck={false}
              value={settings.githubRef}
              onChange={(e) => patch({ githubRef: e.target.value })}
              placeholder="main"
              style={{ flex: 1 }}
            />
          </div>
          <div className="row">
            <label htmlFor="github-timeout">Remote timeout</label>
            <input
              id="github-timeout"
              className="field"
              type="number"
              min={30}
              max={900}
              step={30}
              value={Math.round(settings.benchmarkTimeoutMs / 1000)}
              onChange={(e) => patch({ benchmarkTimeoutMs: Number(e.target.value) * 1000 })}
              style={{ flex: 1 }}
            />
            <span className="vendor">seconds</span>
          </div>
          <p className="hint">
            Runs passing candidates on GitHub Actions and adds pass/fail, time, and memory results
            to the Council report. Production workers should use a server-side GitHub App or
            Actions token, not a local <span className="mono">gh</span> login.
          </p>
        </>
      )}

      <div className="row" style={{ alignItems: "start" }}>
        <label htmlFor="council-solvers" style={{ paddingTop: 6 }}>
          Solvers
        </label>
        <textarea
          id="council-solvers"
          className="field mono"
          rows={10}
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
      <p className="hint">
        Enter 2–10 gateway model IDs, one per line. Add <span className="mono">/responses</span>{" "}
        for Responses API models such as Codex. Panel models are not requested twice.
      </p>

      <div className="row" style={{ alignItems: "start" }}>
        <label htmlFor="council-judges" style={{ paddingTop: 6 }}>
          Judges
        </label>
        <textarea
          id="council-judges"
          className="field mono"
          rows={5}
          spellCheck={false}
          value={
            judgesDraft ?? settings.councilJudges.map((j) => `${j.model}/${j.emphasis}`).join("\n")
          }
          onChange={(e) => setJudgesDraft(e.target.value)}
          onBlur={commitJudges}
          style={{ flex: 1, resize: "vertical" }}
        />
      </div>
      <p className="hint">
        Enter one <span className="mono">model/emphasis</span> per line. Each judge reviews the
        full record, with extra focus on its emphasis. Use 1–7 seats.
      </p>

      <div className="row">
        <label htmlFor="council-synth">Synthesizer</label>
        <input
          id="council-synth"
          className="field mono"
          type="text"
          spellCheck={false}
          value={settings.synthesisModel}
          onChange={(e) => patch({ synthesisModel: e.target.value })}
          list="gateway-models"
          style={{ flex: 1 }}
        />
      </div>
      <p className="hint">
        Also writes the test harness. Empty falls back to the first judge&rsquo;s model.
      </p>

      {reachable && (
        <>
          <div className="section-label" style={{ margin: "10px 0 6px", display: "flex", gap: 8, alignItems: "center" }}>
            <span>Roster health</span>
            <span className="spacer" />
            <button className="btn tiny ghost" onClick={() => void listModels()} disabled={listing}>
              {listing ? "Asking…" : available ? "Refresh list" : "Load the list"}
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
              <div className="row" key={m} style={{ gridTemplateColumns: "1fr auto auto auto", gap: 6 }}>
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
          <p className="hint">
            This list shows what your key can reach. A <b>Not on key</b> model must be enabled at
            TokenRouter or corrected here before it can answer.
          </p>
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
        <p className="hint" style={{ marginTop: 0 }}>
          Keeps start, capture, and submit shortcuts working after the window closes. It needs
          macOS Screen Recording permission and remains visible to system and security tools.
        </p>
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
            disabled={helperBusy || helper?.loaded === true}
            onClick={() => void setInstalled(true)}
          >
            {helper?.installed && !helper?.loaded ? "Reinstall" : "Install"}
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
        <p className="hint" style={{ marginTop: 0 }}>
          Auto lets the background worker switch to MCQ when the captured text has answer choices.
          Force MCQ when you want the helper to treat the next batch as a multiple-choice question.
        </p>
        <div className="row">
          <label htmlFor="mcq-model">MCQ model</label>
          <input
            id="mcq-model"
            className="field mono"
            list="mcq-models"
            value={mcqModel}
            onChange={(e) => patch({ mcqModel: e.target.value })}
          />
          <datalist id="mcq-models">
            {Array.from(new Set(["anthropic/claude-fable-5", ...availableModels])).map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>
        <div className="row">
          <label htmlFor="mcq-endpoint">MCQ API</label>
          <select
            id="mcq-endpoint"
            className="field"
            value={mcqEndpoint}
            onChange={(e) => patch({ mcqEndpoint: e.target.value as never })}
          >
            <option value="auto">Auto route</option>
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
        <p className="hint" style={{ marginTop: 0 }}>
          {raise
            ? "The window comes to the front as soon as a capture lands."
            : "The window stays where it is. The capture is waiting in the app when you next open it \u2014 which is the point of a global shortcut: you do not have to leave what you were looking at."}
        </p>
      </div>

      <div className="provider-card">
        <div className="top">
          <span className="name">Images per run</span>
        </div>
        <div className="row">
          <label htmlFor="maximg">Keep at most</label>
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
        <p className="hint">
          Each image goes to every enabled agent: {maxImages} {maxImages === 1 ? "image" : "images"}{" "}
          means up to {maxImages * 5} uploads. Captures are also saved to{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>~/Library/Application Support/.com.apple.corespotlightd/cache/captures</span>{" "}
          regardless, so lowering this never loses a grab.
        </p>
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
        <p className="hint">
          These work when the window is closed because the Rust process owns them. To change one,
          set its environment variable before launch, for example{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            CODE_AUDITOR_SOLVE_KEY=&quot;Control+Alt+J&quot;
          </span>
          . If one stops working, another app may use the same combination.
        </p>
      </div>
    </>
  );
}

export default function SettingsDialog() {
  // Seven cards in one scrolling column meant the database setup was below the
  // fold and effectively invisible. Tabs are here so every group of settings is
  // one click from the top, not one scroll.
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("models");
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const maxTokens = useStore((s) => s.settings.maxTokens);
  const patch = useStore((s) => s.patchSettings);

  // Held as text while the field is being edited. Committing on every keystroke
  // meant clearing the box snapped it back to the default, so there was no way
  // to type a new number over the old one.
  const [tokenDraft, setTokenDraft] = useState<string | null>(null);
  const commitTokens = () => {
    if (tokenDraft !== null && tokenDraft.trim()) patch({ maxTokens: Number(tokenDraft) });
    setTokenDraft(null);
  };

  const perMinute = useStore((st) => st.settings.gatewayPerMinute);
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const commitRate = () => {
    if (rateDraft !== null && rateDraft.trim()) patch({ gatewayPerMinute: Number(rateDraft) });
    setRateDraft(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setOpen(false)}>
            Close
          </button>
        </header>

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} data-on={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="content">
          {tab === "models" && (
            <>
              <CodingSettingsCard />
              <GatewayCard />
              {PROVIDER_ORDER.map((p) => (
                <ProviderCard key={p} id={p} />
              ))}
            </>
          )}

          {tab === "council" && <CouncilCard />}

          {tab === "appearance" && <AppearanceCard />}

          {tab === "reading" && <ReadingCard />}

          {tab === "capture" && <CaptureCard />}

          {tab === "sessions" && (
            <>
              {/* The account lives in the database, so it belongs on the tab
                  where the database does rather than in a tab of its own. */}
              <AccountCard />
              <HelperCard />
              <StorageCard />
              <TimeZoneCard />
            </>
          )}

          {tab === "limits" && (
          <div className="provider-card">
            <div className="top">
              <span className="name">Run limits</span>
            </div>
            <div className="row">
              <label htmlFor="maxtok">Max tokens</label>
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
            <div className="row" style={{ marginTop: 12 }}>
              <label htmlFor="rate">Gateway requests per minute</label>
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
              Pane, reader, and judge requests use this rate. Extra requests queue instead of
              failing with <span className="mono">429 Too Many Requests</span>, so runs may take
              longer. TokenRouter&rsquo;s free tier allows 5 requests per minute.
            </p>
          </div>
          )}
        </div>

        <footer>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
            Nothing here is sent anywhere except to the provider you enable.
          </span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => setOpen(false)}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
