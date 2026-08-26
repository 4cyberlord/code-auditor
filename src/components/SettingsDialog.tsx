"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  EXTRA_AGENTS,
  FREE_ROUTER_MODELS,
  GATEWAY,
  PROVIDERS,
  PROVIDER_ORDER,
  VISION_PROVIDERS,
  type ProviderId,
  STORAGE,
} from "@/lib/models";
import { MAX_IMAGES, MAX_TOKENS_RANGE, useStore } from "@/lib/store";
import { HOME_ZONE, detectZone, isUsableZone, zoneLabel } from "@/lib/when";
import * as bridge from "@/lib/bridge";
import DatabaseCard from "./DatabaseCard";
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
          different endpoint
          <button
            className="btn tiny ghost"
            style={{ padding: "0 6px", height: "auto", lineHeight: 1.2, fontSize: 10 }}
            onClick={() => void setEndpointFor(modelId, "responses")}
            title="Probe again over the Responses API"
          >
            use responses
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
        <span className="vendor">where screenshots live</span>
        {saved ? (
          <span className="badge" data-tone="good">
            uploading
          </span>
        ) : (
          <span className="badge" data-tone="warn">
            no key
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
        Every screenshot is uploaded to a private <span className="mono">{STORAGE.bucket}</span>{" "}
        bucket in your own Supabase project, and the copy on this machine is deleted as soon as the
        row exists. That is what makes a session openable from another device later. Needs{" "}
        {STORAGE.requires} — the anon key cannot write to a private bucket. The project URL is
        worked out from your database connection string, so there is nothing else to paste.
      </p>

      {note && (
        <p className="hint" style={{ color: "var(--text)" }}>
          {note}
        </p>
      )}
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
        Stored rather than detected fresh each time, so a session captured at home still reads as
        home time when the laptop is somewhere else. Nashville is Central —{" "}
        <span className="mono">America/Chicago</span> — not Eastern. A display setting only: every
        timestamp is stored as an instant, so changing this re-reads history rather than rewriting
        it.
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

  const tested = modelsInUse.filter((m) => probes[m]).length;
  const working = modelsInUse.filter((m) => probes[m]?.ok).length;

  // The pane rows are editable settings; the council roster is configured in
  // its own tab. Anything on the roster that is not already a pane/judge/reader
  // row appears read-only below them, with its probe badge, so the card shows
  // every model this key will actually be asked for.
  const paneIds = modelsInUse.filter((m) =>
    PROVIDER_ORDER.some((p) => (routerModels[p] || PROVIDERS[p].defaultRouterModel) === m)
  );
  const extraIds: string[] = EXTRA_AGENTS.map((e) => e.model);
  const councilOnlyModels = councilEnabled
    ? modelsInUse.filter(
        (m) => !paneIds.includes(m) && !extraIds.includes(m) &&
          m !== (routerModels[judgeProvider] || PROVIDERS[judgeProvider].defaultRouterModel) &&
          !extractors.some((x) => (routerModels[x] || PROVIDERS[x].defaultRouterModel) === m)
      )
    : [];

  const refreshModels = useCallback(async () => {
    setListing(true);
    setListError(null);
    try {
      setAvailable(await bridge.listGatewayModels(baseUrl));
    } catch (err) {
      setAvailable(null);
      setListError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setListing(false);
    }
  }, [baseUrl]);

  // The catalogue is asked for on a button press, not on Settings open: reading
  // it goes through the gateway's request budget, and a pane's tokens matter
  // more than pre-warming a datalist. A fresh key starts with the built-in
  // suggestions until you press Refresh.
  useEffect(() => {
    if (!active) setAvailable(null);
  }, [active]);

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
            routing all panes
          </span>
        ) : saved ? (
          <span className="badge" data-tone="warn">
            saved, switched off
          </span>
        ) : (
          <span className="badge" data-tone="warn">
            not set up
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
            <span>Model ids on the router</span>
            <span className="spacer" />
              {available ? (
                <span className="chip">{available.length} on this key</span>
              ) : (
                <span className="chip" title="The catalogue is fetched on demand, through the rate budget, so a pane's tokens are never spent pre-warming a dropdown.">
                  asking on demand
                </span>
              )}
            <button
              className="btn tiny ghost"
              onClick={() => void refreshModels()}
              disabled={listing}
            >
              {listing ? "Asking…" : "Refresh list"}
            </button>
            {/* Listing tells you what the key is entitled to. This tells you what
                answers. They are not the same question, and the gap between them
                is where every confusing 403 in this project has lived. */}
            <button
              className="btn tiny"
              onClick={() => void testModels(modelsInUse, false)}
              disabled={probing}
              title="One cheap text call per model, through the rate governor"
            >
              {probing ? `Testing… ${tested}/${modelsInUse.length}` : "Test these models"}
            </button>
            <button
              className="btn tiny ghost"
              onClick={() => void testModels(modelsInUse, true)}
              disabled={probing}
              title="Text plus one image probe per model: twice the requests, at the governor's pace"
            >
              {probing ? `${tested}/${modelsInUse.length}` : "+ vision"}
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
                  key&rsquo;s budget, <span className="mono">timeout</span> means the model sat
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
          {PROVIDER_ORDER.map((p) => {
            const id = routerModels[p] || PROVIDERS[p].defaultRouterModel;
            const probe = probes[id];
            const roles = [
              p === judgeProvider ? "judge" : null,
              extractors.includes(p) ? "reader" : null,
            ].filter(Boolean);
            return (
            <div className="row" key={p}>
              <label htmlFor={`rm-${p}`}>
                {PROVIDERS[p].label}
                {/* A model can be a pane, the judge and a reader at once. When it
                    fails, knowing which of those just broke is the difference
                    between one fix and three. */}
                {roles.length > 0 && (
                  <span className="role-tag"> + {roles.join(" + ")}</span>
                )}
              </label>
              <input
                id={`rm-${p}`}
                className="field mono"
                list={`rm-list-${p}`}
                // Flagged when the router has given us a list and this is not on
                // it: the difference between a typo and a model you have not
                // enabled yet.
                data-unknown={!!available && !available.includes(routerModels[p])}
                value={routerModels[p]}
                spellCheck={false}
                placeholder={PROVIDERS[p].defaultRouterModel}
                onChange={(e) => patch({ routerModels: { ...routerModels, [p]: e.target.value } })}
              />
              {probe && <ProbeBadge probe={probe} modelId={routerModels[p] || PROVIDERS[p].defaultRouterModel} />}
              {/* Vision is asked separately because it has a separate answer. A
                  model can answer text through this gateway and still have its
                  connection dropped the moment a picture is attached. */}
              {probe?.vision != null && (
                <span
                  className="badge"
                  data-tone={probe.vision ? "good" : "warn"}
                  title={probe.visionNote ?? ""}
                >
                  {probe.vision ? "sees images" : "text only"}
                </span>
              )}
              {/* The live list once we have one; the built-in guesses only until
                  then. Suggesting a model the key cannot reach is worse than
                  suggesting nothing, because it looks like a working choice. */}
              <datalist id={`rm-list-${p}`}>
                {Array.from(
                  new Set(
                    available ?? [
                      ...PROVIDERS[p].knownRouterModels,
                      ...FREE_ROUTER_MODELS.map((m) => m.id),
                      // The council roster belongs in the suggestions too: a model
                      // sitting in a judge's seat should be offerable as a pane
                      // without having to retype its id.
                      ...councilModels.map((x) => x.id),
                      ...councilJudges.map((j) => j.model),
                    ]
                  )
                ).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            );
          })}

          {/* Council-only roster entries: not panes, so no editable field —
              the roster lives in the Council tab — but their seats land here
              with the same truth badges, so this card shows every model the
              key will actually be asked for. */}
          {councilOnlyModels.length > 0 && (
            <div className="section-label" style={{ margin: "10px 0 2px" }}>
              Council roster
            </div>
          )}
          {councilOnlyModels.map((m) => {
            const probe = probes[m];
            const roles = rolesFor(m);
            return (
              <div className="row" key={m}>
                <label>
                  {m.split("/").pop()}
                  {roles.length > 0 && <span className="role-tag"> + {roles.join(" + ")}</span>}
                </label>
                <span className="field mono" style={{ opacity: 0.7 }}>
                  {m}
                </span>
                {probe && <ProbeBadge probe={probe} modelId={m} />}
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
        {note ??
          (active
            ? "All four panes go through this one endpoint, including any that also have their own vendor key \u2014 one route for the whole panel, so a disagreement between two answers is about the models rather than about how they were reached."
            : "Set this up and one key reaches GPT, Claude, Kimi and Gemini together. Without it each pane needs its own vendor key, and the panes without one will not run.")}
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
            direct
          </span>
        ) : (
          <span className="badge" data-tone="bad">
            no route
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
            This pane is reached through {GATEWAY.label}, so the key and model above are
            not in use. They are kept rather than cleared, so switching the router off
            puts this pane straight back on its own credential.
          </>
        ) : (
          <>
            Keys are written to the macOS Keychain and read only inside the app process.{" "}
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
      "Each pane gets whatever it can use. Models that can see get the screenshot and read it themselves; text-only models get a transcription instead, and one is only made when somebody actually needs it. No configuration, and no paying for a reading pass a panel of vision models did not need.",
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
      "Two vision models transcribe the screenshot, their readings are compared, and the agents work from the agreed text. This is what lets a model that cannot see — DeepSeek, Qwen, Codex through the Router — join the panel. It costs two extra calls, and adds a step where one misread character becomes everyone's.",
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

      <p className="hint" style={{ marginTop: 0 }}>
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
  { id: "reading" as const, label: "Reading" },
  { id: "capture" as const, label: "Capture" },
  { id: "sessions" as const, label: "Sessions" },
  { id: "limits" as const, label: "Limits" },
];

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
  const codespacesStatus = useStore((st) => st.codespacesStatus);
  const codespacesLoading = useStore((st) => st.codespacesLoading);
  const refreshCodespaces = useStore((st) => st.refreshCodespaces);

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
        After the panel answers, the council independently re-solves the problem with the
        roster below, executes every code candidate against a harness one model writes,
        has every solver review every anonymised candidate, revise, and then hands the
        whole record to the bench and a synthesizer. A candidate that fails its tests
        cannot win, whatever the voting says — execution evidence is the gate, not a
        weight. Expect roughly three dozen extra requests per run, paced by the
        gateway limit, so a 5-per-minute plan is a slow council, not a broken one.
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
        <label htmlFor="codespaces-benchmark">Remote benchmark</label>
        <div className="segmented" style={{ flex: 1 }}>
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              data-on={settings.codespacesBenchmark === v}
              style={{ flex: 1 }}
              onClick={() => {
                patch({ codespacesBenchmark: v });
                if (v && !codespacesStatus && !codespacesLoading) void refreshCodespaces();
              }}
            >
              {v ? "Codespaces" : "Local only"}
            </button>
          ))}
        </div>
      </div>

      {settings.codespacesBenchmark && (
        <>
          <div className="row">
            <label htmlFor="codespaces-name">Codespace</label>
            <input
              id="codespaces-name"
              className="field mono"
              type="text"
              spellCheck={false}
              value={settings.codespacesName}
              onChange={(e) => patch({ codespacesName: e.target.value })}
              list="codespaces-list"
              placeholder="friendly-or-generated-codespace-name"
              style={{ flex: 1 }}
            />
            <button className="btn tiny" onClick={() => void refreshCodespaces()} disabled={codespacesLoading}>
              {codespacesLoading ? "Checking..." : "Refresh"}
            </button>
          </div>
          <datalist id="codespaces-list">
            {(codespacesStatus?.codespaces ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {[c.displayName, c.repository, c.machineName, c.state].filter(Boolean).join(" - ")}
              </option>
            ))}
          </datalist>
          <div className="row">
            <label htmlFor="codespaces-timeout">Remote timeout</label>
            <input
              id="codespaces-timeout"
              className="field"
              type="number"
              min={5}
              max={120}
              step={5}
              value={Math.round(settings.codespacesTimeoutMs / 1000)}
              onChange={(e) => patch({ codespacesTimeoutMs: Number(e.target.value) * 1000 })}
              style={{ flex: 1 }}
            />
            <span className="vendor">seconds</span>
          </div>
          <p className="hint">
            Runs passing council candidates through <span className="mono">gh codespace ssh</span>,
            using the same generated harness. GitHub CLI auth stays outside this app. The result is
            repeatable remote evidence, not a promise that LeetCode will display the same rounded
            runtime.
            {codespacesStatus?.error ? ` ${codespacesStatus.error}` : ""}
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
        One gateway model id per line, 2–10. An id alone uses chat-completions;
        add <span className="mono">/responses</span> to it for a model that lives on the
        Responses API (Codex is the one in the defaults). The panel&rsquo;s own models are
        never duplicated — their answers already stand as its seats.
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
        One per line as <span className="mono">model/emphasis</span>. Every judge reviews
        the whole record; the emphasis is only what it looks at hardest. 1–7 seats.
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
            The built-in list is what the router said your key can reach. Anything
            marked <b>not on key</b> needs enabling at TokenRouter (or the id fixing here)
            before that seat can answer.
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
  const patch = useStore((s) => s.patchSettings);

  return (
    <>
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
          Every image goes to every enabled agent, so this multiplies: {maxImages}{" "}
          {maxImages === 1 ? "image" : "images"} across five panes is {maxImages * 5} image
          uploads in one press. Captures are saved to{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>~/Pictures/Code Auditor</span>{" "}
          regardless, so lowering this never loses a grab.
        </p>
      </div>

      <div className="provider-card">
        <div className="top">
          <span className="name">Shortcuts</span>
          <span className="spacer" />
          <span className="vendor">system-wide</span>
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
          These work whether or not the window is open, because they are claimed by the
          Rust process rather than the page. To change one, set its environment variable
          before launching \u2014 for example{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            CODE_AUDITOR_SOLVE_KEY=&quot;Control+Alt+J&quot;
          </span>
          . If a shortcut stops working, another app has claimed the same combination.
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

  // Land on whatever is unfinished. Someone opening Settings with no database
  // configured is almost certainly looking for the database, and it was the tab
  // they would have had to go hunting for.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void bridge.dbHasUrl().then((has) => {
      if (live && !has) setTab("sessions");
    });
    return () => {
      live = false;
    };
  }, [open]);

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
              <GatewayCard />
              {PROVIDER_ORDER.map((p) => (
                <ProviderCard key={p} id={p} />
              ))}
            </>
          )}

          {tab === "council" && <CouncilCard />}

          {tab === "reading" && <ReadingCard />}

          {tab === "capture" && <CaptureCard />}

          {tab === "sessions" && (
            <>
              <DatabaseCard />
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
              Applies per agent, per run. Reasoning models spend part of this budget thinking, so
              leave headroom for long solutions. Clamped to {MAX_TOKENS_RANGE.min}–
              {MAX_TOKENS_RANGE.max}.
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
              A run is one request per pane, plus one per screenshot reader and one for the judge.
              Above this rate they queue instead of failing, so a run gets slower rather than
              losing panes to <span className="mono">429 Too Many Requests</span>. TokenRouter&rsquo;s
              free tier is 5 a minute; if a 429 arrives anyway the app lowers this itself and
              keeps the lower figure.
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
