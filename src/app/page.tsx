"use client";

import { useEffect } from "react";
import AgentPane from "@/components/AgentPane";
import ConsensusPanel from "@/components/ConsensusPanel";
import CouncilPanel from "@/components/CouncilPanel";
import InputBar from "@/components/InputBar";
import ReadingPanel from "@/components/ReadingPanel";
import SettingsDialog from "@/components/SettingsDialog";
import SessionSidebar from "@/components/SessionSidebar";
import Splitter from "@/components/Splitter";
import { useAgentEvents } from "@/lib/useAgentEvents";
import { useGlobalShortcuts } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";
import Toasts from "@/components/Toasts";
import { inTauri } from "@/lib/bridge";

export default function Page() {
  const agents = useStore((s) => s.agents);
  const hydrated = useStore((s) => s.hydrated);
  const hydrate = useStore((s) => s.hydrate);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const running = useStore((s) => s.running);
  const sessionsOpen = useStore((s) => s.settings.sessionsOpen);

  // Only enabled providers get a pane. With five to choose from, rendering the
  // switched-off ones as placeholders would spend half the screen on nothing --
  // and the toggles live in Settings, which is where you would look anyway.
  const panes = agents.filter((a) => a.enabled);

  useAgentEvents();
  useGlobalShortcuts();

  useEffect(() => {
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
          Code Auditor
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

        {/* The verdict, and the history that produced it, in one column. Sessions
            sits under the solution rather than beside the panes: it is something
            you go and look at, not something you watch. */}
        <div className="rail" data-sessions={sessionsOpen}>
          <CouncilPanel />
          <ConsensusPanel />
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
