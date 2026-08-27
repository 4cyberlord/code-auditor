"use client";

import { useEffect } from "react";
import AgentPane from "@/components/AgentPane";
import BackgroundJobsPanel from "@/components/BackgroundJobsPanel";
import ConsensusPanel from "@/components/ConsensusPanel";
import SolutionCard from "@/components/SolutionCard";
import CouncilPanel from "@/components/CouncilPanel";
import HistoryPanel from "@/components/HistoryPanel";
import InputBar from "@/components/InputBar";
import ReadingPanel from "@/components/ReadingPanel";
import SettingsDialog from "@/components/SettingsDialog";
import SessionSidebar from "@/components/SessionSidebar";
import StartupLoader from "@/components/StartupLoader";
import Splitter from "@/components/Splitter";
import { useAgentEvents } from "@/lib/useAgentEvents";
import { useGlobalShortcuts } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";
import Toasts from "@/components/Toasts";
import LoginScreen from "@/components/LoginScreen";
import { inTauri } from "@/lib/bridge";
import { gateFor, useAuth } from "@/lib/auth";
import { devLog } from "@/lib/devLog";

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
  const status = useAuth((s) => s.status);
  const ready = useAuth((s) => s.ready);
  const refresh = useAuth((s) => s.refresh);
  const apply = useAuth((s) => s.apply);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const gate = gateFor(status, ready);

  useEffect(() => {
    devLog("gate", "state changed", {
      gate,
      ready,
      authenticated: status?.authenticated ?? false,
      dbConfigured: status?.dbConfigured ?? false,
      problem: status?.problem ?? null,
    });
  }, [gate, ready, status]);

  if (gate === "loading") return <StartupLoader />;
  if (gate === "connect" || gate === "login") {
    return <LoginScreen gate={gate} status={status} onChanged={apply} />;
  }
  return <Workbench />;
}

function Workbench() {
  const agents = useStore((s) => s.agents);
  const hydrated = useStore((s) => s.hydrated);
  const hydrate = useStore((s) => s.hydrate);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const running = useStore((s) => s.running);
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

  useEffect(() => {
    devLog("workbench", "hydrate started");
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
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
    return () => window.removeEventListener("keydown", onKey);
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
        <button className="btn ghost" onClick={() => setSettingsOpen(true)} title="Settings (⌘,)">
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

      <ReadingPanel />

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

      <InputBar />

      <SettingsDialog />

      <Toasts />
    </div>
  );
}
