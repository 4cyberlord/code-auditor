"use client";

import { useEffect } from "react";
import { formatWhen } from "@/lib/when";
import { useStore } from "@/lib/store";

/**
 * Dedicated History Panel in the rail.
 *
 * Every completed run is preserved in Postgres and read back here. Clicking a run
 * loads the exact answers and verdict back into the panes for inspection.
 */
export default function HistoryPanel() {
  const history = useStore((s) => s.history);
  const historyLoading = useStore((s) => s.historyLoading);
  const historyError = useStore((s) => s.historyError);
  const viewingRunId = useStore((s) => s.viewingRunId);
  const loadHistory = useStore((s) => s.loadHistory);
  const openRun = useStore((s) => s.openRun);
  const exitHistory = useStore((s) => s.exitHistory);
  const running = useStore((s) => s.running);
  const current = useStore((s) => s.currentSessionId);
  const zone = useStore((s) => s.settings.timeZone);

  const open = useStore((s) => s.settings.railPanel === "history");
  const toggleRail = useStore((s) => s.toggleRailPanel);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, current, running]);

  return (
    <aside className="history-panel" data-open={open}>
      <div
        className="side-head drawer-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => toggleRail("history")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleRail("history");
          }
        }}
        title={open ? "Collapse" : "Show run history"}
      >
        <span className="chev" aria-hidden="true">
          ▾
        </span>
        <h2>History</h2>
        {!open && history.length > 0 && (
          <span className="chip">{history.length}</span>
        )}
        <span className="spacer" />
        {open && viewingRunId && (
          <button
            className="btn tiny ghost"
            onClick={(e) => {
              e.stopPropagation();
              exitHistory();
            }}
            title="Return to live run state"
          >
            Back to live
          </button>
        )}
      </div>

      {open && (
        <div className="history-panel-body">
          {viewingRunId && (
            <div className="history-inspecting-notice">
              <span>Inspecting saved run</span>
              <button className="btn tiny ghost" onClick={() => exitHistory()}>
                Exit
              </button>
            </div>
          )}

          {historyError && <div className="pane-error">{historyError}</div>}

          {!current && (
            <div className="empty" style={{ padding: 20 }}>
              Select a session to view its past runs.
            </div>
          )}

          {current && !historyLoading && !history.length && !historyError && (
            <div className="empty" style={{ padding: 20 }}>
              No finished runs in this session yet. Runs are saved automatically once completed.
            </div>
          )}

          {current && historyLoading && !history.length && (
            <div className="empty" style={{ padding: 20 }}>
              Loading runs…
            </div>
          )}

          {current && history.length > 0 && (
            <div className="history-list">
              {history.map((r) => {
                const isCurrent = r.id === viewingRunId;
                const askedText = r.asked.trim()
                  ? r.asked.trim().split("\n")[0]
                  : "(no note — solved from screenshot)";

                return (
                  <button
                    key={r.id}
                    className="history-row"
                    data-current={isCurrent}
                    disabled={running}
                    title={
                      running
                        ? "Finish the current run first"
                        : "Show this run in the panes"
                    }
                    onClick={() => void openRun(r.id)}
                  >
                    <div className="history-asked" title={r.asked.trim() || undefined}>
                      {askedText}
                    </div>
                    <div className="history-meta">
                      <span>{formatWhen(r.startedAt, zone, "relative")}</span>
                      <span>·</span>
                      <span>
                        {r.answered} {r.answered === 1 ? "answer" : "answers"}
                      </span>
                      {r.verdict && (
                        <>
                          <span>·</span>
                          <span className="history-verdict">{r.verdict}</span>
                        </>
                      )}
                      {r.reliability && (
                        <>
                          <span>·</span>
                          <span>{r.reliability}</span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
