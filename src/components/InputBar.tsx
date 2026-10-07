"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LEGIBLE_SCALE, canSeeVia, routeFor, useStore } from "@/lib/store";
import { ALL_AGENTS, GATEWAY, agentSpec, type AgentId } from "@/lib/models";
import { preflight, pace, gatewayRequests } from "@/lib/preflight";
import { SHORTCUT_LABELS } from "@/lib/shortcuts";
import ImagePreview from "./ImagePreview";
import { assetsFromBlob, assetsFromClipboard, assetsFromDataTransfer, humanBytes } from "@/lib/image";
import type { ImageAsset } from "@/lib/store";
import type { Mode } from "@/lib/prompts";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Each agent decides whether it is a coding problem or a research question" },
  { id: "code", label: "Code", hint: "Force the coding workflow: solve, trace, state complexity" },
  { id: "research", label: "Research", hint: "Force the reasoning workflow for non-coding questions" },
];

export default function InputBar() {
  const images = useStore((s) => s.images);
  const note = useStore((s) => s.note);
  const mode = useStore((s) => s.settings.mode);
  const running = useStore((s) => s.running);
  const keys = useStore((s) => s.keys);
  const gatewayKey = useStore((s) => s.gatewayKey);
  const storageKey = useStore((s) => s.storageKey);
  const uploads = useStore((s) => s.uploads);
  const settings = useStore((s) => s.settings);
  const enabled = useStore((s) => s.settings.enabled);
  const limit = useStore((s) => s.settings.maxImages);

  const addImages = useStore((s) => s.addImages);
  const removeImage = useStore((s) => s.removeImage);
  const setNote = useStore((s) => s.setNote);
  const patch = useStore((s) => s.patchSettings);
  const start = useStore((s) => s.start);
  const cancel = useStore((s) => s.cancel);
  const reset = useStore((s) => s.reset);

  const shortcutError = useStore((s) => s.shortcutError);

  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const ingest = useCallback(
    async (task: Promise<ImageAsset[]>) => {
      try {
        const assets = await task;
        if (!assets.length) {
          setProblem("That didn't contain an image I could read.");
          return;
        }
        const dropped = addImages(assets);
        setProblem(
          dropped
            ? `Only ${limit} ${limit === 1 ? "image fits" : "images fit"} per run, so ${dropped} ${dropped === 1 ? "was" : "were"} left out.`
            : null
        );
      } catch (err) {
        setProblem(`Could not read that image: ${String(err)}`);
      }
    },
    [addImages, limit]
  );

  // Cmd+V anywhere in the window drops a screenshot straight in.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT";
      const hasImage = Array.from(e.clipboardData?.items ?? []).some(
        (i) => i.kind === "file" && i.type.startsWith("image/")
      );
      // Paste inside the note box still captures an image; only plain text is
      // left alone so typing is never hijacked.
      if (!hasImage) return;
      if (typing) e.stopPropagation();
      e.preventDefault();
      void ingest(assetsFromClipboard(e));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [ingest]);

  // Readiness has to be asked of the route, not of the vendor key.
  //
  // This counted `enabled[p] && keys[p]`, which predates the gateway and quietly
  // broke its entire promise: someone with a TokenRouter key and no vendor keys
  // had four panes that could all run, a count of zero, and a greyed-out Run
  // button telling them nothing was ready.
  const routes = ALL_AGENTS.filter((p) => routeFor(p, settings, keys, gatewayKey) !== null);
  const activeCount = ALL_AGENTS.filter(
    (p) => enabled[p] && routes.includes(p)
  ).length;

  // Said before the run, not after it. Every case this catches was already
  // knowable from the settings, and the alternative is reverse-engineering your
  // own configuration out of four identical vendor 403s.
  const check = preflight({
    imageCount: images.length,
    contextMode: settings.contextMode,
    enabled,
    reachable: routes,
    extractors: settings.extractors,
    smallestScale: images.reduce((m, i) => Math.min(m, i.scale ?? 1), 1),
    // What the probe measured, where it has measured anything. The warning above
    // the Run button should describe the models you actually have, not the ones
    // the table says you have.
    sees: Object.fromEntries(
      ALL_AGENTS.map((p) => [p, canSeeVia(p, routeFor(p, settings, keys, gatewayKey), settings)])
    ) as Partial<Record<AgentId, boolean>>,
  });

  // What this press will cost against the gateway's per-minute budget. Said
  // before the wait rather than discovered during it: six panes queued behind a
  // rate limit look exactly like six panes hung.
  const onGateway = (p: AgentId) => routeFor(p, settings, keys, gatewayKey)?.viaGateway === true;
  // The council adds its own phases on top of the panes. Counting them keeps
  // the pace note honest: a ten-seat council at five a minute is several
  // minutes of dispatch, and pretending it is just the panel's count is how
  // people discover the queue exists.
  const councilRequests = settings.councilEnabled
    ? settings.councilModels.length + settings.councilJudges.length + 1
    : 0;
  const paceNote = pace(
    gatewayRequests({
      panesOnGateway: ALL_AGENTS.filter((p) => enabled[p] && onGateway(p)).length,
      readersOnGateway: settings.extractors.filter(onGateway).length,
      hasImages: images.length > 0,
      contextMode: settings.contextMode,
      autoJudge: settings.autoJudge !== "off" && !settings.councilEnabled,
      judgeOnGateway: onGateway(settings.judgeProvider),
      // Always true now that the transcriber is on-device: Apple Vision needs no
      // key and spends no gateway budget, so the picture never costs a request.
      ocr: true,
      anyBlind: ALL_AGENTS.some(
        (p) =>
          enabled[p] && !canSeeVia(p, routeFor(p, settings, keys, gatewayKey), settings)
      ),
    }) + councilRequests,
    settings.gatewayPerMinute
  );

  // Counted by capture, matching how `addImages` and the uploader key them, so a
  // tiled whole-screen grab reads as one screenshot here too.
  const stored = (() => {
    const keys = [...new Set(images.map((i) => i.group ?? i.name))];
    let failed = 0;
    let pending = 0;
    let why: string | undefined;
    for (const k of keys) {
      const u = uploads[k];
      if (!u) continue;
      if (u.state === "failed") {
        failed++;
        why = why ?? u.why;
      } else if (u.state === "uploading") pending++;
    }
    return { total: keys.length, failed, pending, why };
  })();

  const canRun =
    !running &&
    activeCount > 0 &&
    !check.blocking &&
    (images.length > 0 || note.trim().length > 0);

  return (
    <div className="inputbar">
      <div
        className="dropzone"
        data-over={over}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void ingest(assetsFromDataTransfer(e.dataTransfer));
        }}
        onClick={() => picker.current?.click()}
        role="button"
        tabIndex={0}
      >
        <strong style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {SHORTCUT_LABELS.captureScreen} screen {"·"} {SHORTCUT_LABELS.capture} region {"·"} {SHORTCUT_LABELS.captureLeft}/{SHORTCUT_LABELS.captureRight} halves
        </strong>
        <span>
          {SHORTCUT_LABELS.solve} to audit {"·"} or drop, paste, click
        </span>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          // `picker.click()` dispatches a real click that bubbles back up to the
          // dropzone's onClick, which calls `picker.click()` again. Stop it here.
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            void ingest(Promise.all(files.map((f) => assetsFromBlob(f))).then((g) => g.flat()));
            e.target.value = "";
          }}
        />
      </div>

      {images.length > 0 && (
        <div className="thumb-stack">
          <div className="thumbs">
          {images.map((img, i) => (
            <div className="thumb" key={`${img.name}-${i}`}>
              <button
                className="thumb-open"
                onClick={() => setPreview(i)}
                title={`${img.name} — click to view full size`}
                aria-label={`View ${img.name} full size`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.dataUrl} alt={img.name} />
              </button>
              <button className="thumb-remove" onClick={() => removeImage(i)} title="Remove">
                {"\u00D7"}
              </button>
              <div className="meta" data-warn={(img.scale ?? 1) < LEGIBLE_SCALE}>
                {img.tile
                  ? `${img.tile.index}/${img.tile.count}`
                  : (img.scale ?? 1) < LEGIBLE_SCALE
                    ? `${Math.round((img.scale ?? 1) * 100)}% — small text`
                    : humanBytes(img.bytes)}
              </div>
            </div>
          ))}
          </div>

          {/* Where the pictures went. One line, and only when there is something to
              say: the upload is the only step that happens silently in the
              background, and "it is somewhere other than this laptop" is a promise
              worth being able to see rather than assume. Sits under the images
              themselves, since it describes them, not the question field. */}
          {storageKey && stored.total > 0 && (
            <span
              className="preflight"
              data-tone={stored.failed ? "bad" : stored.pending ? "warn" : "good"}
              title={stored.why ?? "Uploaded to your Supabase project; the local copy is deleted."}
            >
              {stored.failed
                ? `${stored.failed} of ${stored.total} could not be saved to your project — ${stored.why}`
                : stored.pending
                  ? `Saving ${stored.pending} of ${stored.total} to your project\u2026`
                  : `${stored.total} saved to your project`}
            </span>
          )}
        </div>
      )}

      <div className="note-wrap">
        <textarea
          className="field"
          rows={2}
          placeholder="Optional: add context, constraints, or type the question directly if you have no screenshot."
          value={note}
          // Problem statements are full of identifiers and operators, so the
          // macOS spell checker has nothing useful to say about them and stalls
          // on long pastes ("NSSpellServer … timed out" in the console).
          spellCheck={false}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canRun) void start();
          }}
        />
        <div className="note-actions">
          <div className="segmented">
            {MODES.map((m) => (
              <button
                key={m.id}
                data-on={mode === m.id}
                title={m.hint}
                onClick={() => patch({ mode: m.id })}
              >
                {m.label}
              </button>
            ))}
          </div>

          <span className="spacer" />

          {(problem || shortcutError) && (
            <span style={{ fontSize: 11, color: "var(--bad)" }}>{problem ?? shortcutError}</span>
          )}

          {!problem && !shortcutError && (check.blocking || check.caution) && (
            <span
              className="preflight"
              data-tone={check.blocking ? "bad" : "warn"}
              title={check.blocking ?? check.caution ?? ""}
            >
              {check.blocking ?? check.caution}
            </span>
          )}

          {/* Its own line rather than folded into the caution above: this is not
              a warning that something is wrong, it is a statement of how long the
              press will take. Suppressed while something is actually wrong,
              because a queue estimate for a run that cannot happen is noise. */}
          {!problem && !shortcutError && !check.blocking && paceNote && (
            <span className="preflight" data-tone="warn" title={paceNote}>
              {paceNote}
            </span>
          )}

          {/* Which models answer, decided here rather than three clicks away in
              Settings. A pane that is switched off vanishes from the grid, so
              this row is also the only way back -- a toggle whose "off" state is
              invisible is a one-way door. */}
          <div className="agent-toggles">
            {ALL_AGENTS.map((p) => {
              const on = enabled[p];
              const reachable = routes.includes(p);
              const spec = agentSpec(p);
              return (
                <button
                  key={p}
                  className="agent-toggle"
                  data-on={on}
                  data-reachable={reachable}
                  onClick={() => patch({ enabled: { ...enabled, [p]: !on } })}
                  title={
                    !reachable
                      ? `${spec.vendor} has no route \u2014 add a ${GATEWAY.label} key, or one for ${spec.vendor}`
                      : on
                        ? `Switch off ${spec.label}`
                        : `Switch on ${spec.label}`
                  }
                >
                  <span
                    className="dot"
                    style={{ background: on ? spec.accent : "transparent" }}
                  />
                  {spec.label}
                </button>
              );
            })}
          </div>

          <button className="btn ghost" onClick={reset} disabled={running}>
            Clear Results
          </button>

          {running ? (
            <button className="btn danger" onClick={() => void cancel()}>
              Stop
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={() => void start()}
              disabled={!canRun}
              title={
                activeCount === 0
                  ? "Add at least one API key in Settings"
                  : !images.length && !note.trim()
                    ? "Add a screenshot or type a question"
                    : "Run all agents (⌘⏎)"
              }
            >
              Run {activeCount > 0 ? activeCount : ""} agents
            </button>
          )}
        </div>
      </div>

      {preview !== null && (
        <ImagePreview
          images={images}
          index={preview}
          onClose={() => setPreview(null)}
          onNavigate={setPreview}
          onRemove={removeImage}
        />
      )}
    </div>
  );
}
