"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import AgentPane from "@/components/AgentPane";
import BackgroundJobsPanel from "@/components/BackgroundJobsPanel";
import ConsensusPanel from "@/components/ConsensusPanel";
import SolutionCard from "@/components/SolutionCard";
import CouncilPanel from "@/components/CouncilPanel";
import KnowledgeWorkspace from "@/components/KnowledgeWorkspace";
import CodingWorkspace from "@/components/CodingWorkspace";
import BootScreen from "@/components/BootScreen";
import HistoryPanel from "@/components/HistoryPanel";
import InputBar from "@/components/InputBar";
import ReadingPanel from "@/components/ReadingPanel";
import SettingsDialog from "@/components/SettingsDialog";
import SessionSidebar from "@/components/SessionSidebar";
import StartupLoader from "@/components/StartupLoader";
import Splitter from "@/components/Splitter";
import { useAgentEvents } from "@/lib/useAgentEvents";
import { useGlobalShortcuts } from "@/lib/shortcuts";
import { useWindowChrome } from "@/lib/windowChrome";
import { useStore } from "@/lib/store";
import Toasts from "@/components/Toasts";
import LoginScreen from "@/components/LoginScreen";
import { inTauri } from "@/lib/bridge";
import { gateFor, useAuth } from "@/lib/auth";
import { devLog } from "@/lib/devLog";

// The desktop session is stored in the system Keychain for thirty days. Do not
// discard it after a short idle or sleep; doing so defeats saved sign-in and
// makes the app ask for the PIN again while the session is still valid.
const IDLE_AUTO_LOCK_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_LOCK_POLL_MS = 15 * 1000;

/**
 * The gate, and nothing else.
 *
 * `Workbench` below is the app as it was. It is a separate component rather than
 * a branch inside one because every hook it owns -- the event listeners, the
 * global shortcuts, the hydrate that reads settings out of Postgres -- assumes a
 * signed-in session. Mounting it only once that is true means none of them need
 * to learn about the lock, and none of them can fire against a database that
 * will refuse them.
 */
export default function Page() {
  const [overlayRoute] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("overlay") === "capture-exempt"
  );
  const status = useAuth((s) => s.status);
  const ready = useAuth((s) => s.ready);
  const refresh = useAuth((s) => s.refresh);
  const apply = useAuth((s) => s.apply);

  useEffect(() => {
    if (!overlayRoute) void refresh();
  }, [overlayRoute, refresh]);

  const gate = gateFor(status, ready);

  useEffect(() => {
    if (overlayRoute) return;
    devLog("gate", "state changed", {
      gate,
      ready,
      authenticated: status?.authenticated ?? false,
      dbConfigured: status?.dbConfigured ?? false,
      problem: status?.problem ?? null,
    });
  }, [gate, overlayRoute, ready, status]);

  if (overlayRoute) return <CaptureExemptOverlay />;
  if (gate === "loading") return <StartupLoader />;
  if (gate === "login") {
    return <LoginScreen gate={gate} status={status} onChanged={apply} />;
  }
  return <Workbench />;
}

function Workbench() {
  type Workspace = "council" | "coding" | "knowledge";
  const [workspace, setWorkspace] = useState<Workspace>("council");
  const agents = useStore((s) => s.agents);
  const hydrated = useStore((s) => s.hydrated);
  const hydrate = useStore((s) => s.hydrate);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const running = useStore((s) => s.running);
  const signOut = useAuth((s) => s.signOut);
  const sessionsOpen = useStore((s) => s.settings.railPanel === "sessions");
  const historyOpen = useStore((s) => s.settings.railPanel === "history");

  // Only enabled providers get a pane. With five to choose from, rendering the
  // switched-off ones as placeholders would spend half the screen on nothing --
  // and the toggles live in Settings, which is where you would look anyway.
  const viewingRunId = useStore((s) => s.viewingRunId);
  const exitHistory = useStore((s) => s.exitHistory);
  const viewingAsked = useStore((s) => {
    const row = s.history.find((r) => r.id === s.viewingRunId);
    return row?.asked.trim().split("\n")[0] ?? "";
  });

  const panes = agents.filter((a) => a.enabled);

  useAgentEvents();
  useGlobalShortcuts();
  useWindowChrome();

  useEffect(() => {
    if (!inTauri()) return;

    let lastActivity = Date.now();
    let locking = false;

    const markActive = () => {
      lastActivity = Date.now();
    };

    const lockIfSafe = () => {
      if (locking || useStore.getState().running) return;
      locking = true;
      void signOut().finally(() => {
        locking = false;
      });
    };

    const checkLock = () => {
      const now = Date.now();
      if (now - lastActivity >= IDLE_AUTO_LOCK_MS) {
        lockIfSafe();
      }
    };

    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const eventName of events) {
      window.addEventListener(eventName, markActive, { passive: true });
    }
    const timer = window.setInterval(checkLock, AUTO_LOCK_POLL_MS);

    return () => {
      window.clearInterval(timer);
      for (const eventName of events) {
        window.removeEventListener(eventName, markActive);
      }
    };
  }, [signOut]);

  useEffect(() => {
    devLog("workbench", "hydrate started");
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    let unlistenSettings: (() => void) | undefined;
    let unlistenWorkspace: (() => void) | undefined;
    if (inTauri()) {
      void listen("settings://open", () => setSettingsOpen(true)).then((off) => {
        unlistenSettings = off;
      });
      void listen<string>("workspace://select", (event) => {
        const next = event.payload;
        if (next === "council" || next === "coding" || next === "knowledge") {
          setWorkspace(next);
        }
      }).then((off) => {
        unlistenWorkspace = off;
      });
    }

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        const s = useStore.getState();
        if (!s.running) void s.start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlistenSettings?.();
      unlistenWorkspace?.();
    };
  }, [setSettingsOpen]);

  return (
    <div className="shell">
      <div className="titlebar" data-tauri-drag-region>
        <span className="brand" data-tauri-drag-region>
          Council Editor
          <span data-tauri-drag-region>
            {running
              ? "running"
              : `${panes.length} ${panes.length === 1 ? "model" : "models"}, one problem, one verdict`}
          </span>
        </span>
        <span className="spacer" data-tauri-drag-region />
        {hydrated && !inTauri() && (
          <span className="badge" data-tone="warn" title="Model calls only work inside the desktop shell.">
            browser preview
          </span>
        )}
        <button
          className="btn tiny ghost"
          onClick={() => setSettingsOpen(true)}
          title="Open Settings (⌘,)"
        >
          Settings
        </button>
      </div>

      {/* The panes are showing a past run. Said plainly, because every control
          around them still looks live and a stale answer read as a fresh one
          is the whole failure mode of a history view. */}
      {viewingRunId && (
        <div className="history-banner">
          <span>
            Showing a saved run{viewingAsked ? ` — “${viewingAsked}”` : ""}. These are the answers as they
            were recorded.
          </span>
          <span className="spacer" />
          <button className="btn tiny" onClick={() => exitHistory()}>
            Back to live
          </button>
        </div>
      )}

      {/* The reading strip is about the screenshot the council is reasoning
          from, so it belongs to that workspace rather than to the window. On
          the Knowledge tab it was describing a run nobody had started. */}
      {workspace === "council" && <ReadingPanel />}

      <div className="workspace-stage" data-workspace={workspace}>
        <div
          className="workspace-panel"
          data-active={workspace === "council"}
          aria-hidden={workspace !== "council"}
          inert={workspace !== "council"}
        >
          <div className="body">
            {/* The count drives the pane layout in CSS; hard-wiring 2x2 broke the
                moment a fifth provider joined. */}
            <div className="grid" data-count={panes.length}>
              {panes.map((a) => (
                <AgentPane key={a.id} agent={a} />
              ))}
            </div>

            {/* Dragging this makes the panes wider or the verdict wider. It writes
                a CSS variable rather than moving anything, so the grid stays the
                single source of truth about the layout. */}
            <Splitter
              axis="col"
              variable="--rail-w"
              min={260}
              max={720}
              reset={344}
              storageKey="code-auditor.layout.rail"
              invert
            />

            {/* The verdict, and the drawers in one column. */}
            <div className="rail" data-sessions={sessionsOpen} data-history={historyOpen}>
              <CouncilPanel />
              <SolutionCard />
              <div className="solution-divider" aria-hidden="true" />
              <ConsensusPanel />
              <BackgroundJobsPanel />
              <HistoryPanel />
              {sessionsOpen && (
                <Splitter
                  axis="row"
                  variable="--sessions-h"
                  min={120}
                  max={620}
                  reset={280}
                  storageKey="code-auditor.layout.sessions"
                  invert
                />
              )}
              <SessionSidebar />
            </div>
          </div>
        </div>

        <div
          className="workspace-panel"
          data-active={workspace === "coding"}
          aria-hidden={workspace !== "coding"}
          inert={workspace !== "coding"}
        >
          <CodingWorkspace />
        </div>

        <div
          className="workspace-panel"
          data-active={workspace === "knowledge"}
          aria-hidden={workspace !== "knowledge"}
          inert={workspace !== "knowledge"}
        >
          <KnowledgeWorkspace active={workspace === "knowledge"} />
        </div>
      </div>

      <BootScreen />

      <div
        className="workspace-input"
        data-active={workspace === "council"}
        aria-hidden={workspace !== "council"}
        inert={workspace !== "council"}
      >
        <InputBar />
      </div>

      <SettingsDialog />

      <Toasts />
    </div>
  );
}

function CaptureExemptOverlay() {
  const [text, setText] = useState("");
  const lines = withOverlayReferenceComment(overlayCodeSample).split("\n");

  useEffect(() => {
    document.documentElement.dataset.overlay = "capture-exempt";
    return () => {
      delete document.documentElement.dataset.overlay;
    };
  }, []);

  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen<string>("overlay://text", (event) => {
      setText(event.payload);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <main className="coding-capture-exempt-overlay" aria-label="Capture exempt overlay">
      <div className="capture-topbar" aria-label="Overlay controls">
        <span className="capture-brand" aria-hidden="true">CA</span>
        <span className="capture-pause" aria-hidden="true">||</span>
        <span className="capture-meter" aria-hidden="true"><i /><i /><i /></span>
        <span className="capture-action">Capture Region</span>
        <span className="capture-key">⌃⌥</span>
        <span className="capture-key">R</span>
        <span className="capture-action">Capture Screen</span>
        <span className="capture-key">⌃⌥</span>
        <span className="capture-key">S</span>
        <span className="capture-action">Solve</span>
        <span className="capture-key">⌃⌥</span>
        <span className="capture-key">A</span>
        <span className="capture-action">Overlay</span>
        <span className="capture-key">⌃⌥</span>
        <span className="capture-key">O</span>
      </div>

      <div className="capture-exempt-panel">
        <section className="capture-notes-card" aria-label="Answer notes">
          <div className="capture-question">
            {text || "How would you design the solution so the most relevant answer is visible quickly?"}
          </div>
          <div className="capture-answer">
            <b>AI response ✨</b>
            <p>
              Break it into clear parts: gather the signal, rank the likely paths, then explain the final
              choice with enough detail to act on it.
            </p>
          </div>
        </section>

        <section className="capture-code-card" aria-label="Numbered code notes">
          <div className="capture-code-head">
            <b>solution.py</b>
            <span>visible notes</span>
          </div>
          <ol className="capture-code-lines">
            {lines.map((line, index) => (
              <li key={`${index}-${line}`}>
                <code>{line || " "}</code>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}

function withOverlayReferenceComment(code: string): string {
  if (code.trimStart().startsWith("#")) return code;
  return `# Reference: solution displayed in the capture overlay\n${code}`;
}

const overlayCodeSample = `def greatest_outlier(arr):
    # Convert the array to a set for O(1) lookups
    seen = set(arr)
    total_sum = sum(arr)
    outliers = []

    for num in arr:
        original_sum = total_sum - num
        # Check if the original sum is in the set, and not this item
        if original_sum in seen:
            outliers.append(num)

    if not outliers:
        return -1

    return max(outliers)`;
