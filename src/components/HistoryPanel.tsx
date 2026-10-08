"use client";

import { useEffect, useState } from "react";
import { modelPerformance, type CouncilReport, type ModelPerformance } from "@/lib/council";
import { getCouncilReport, listSolveJobs } from "@/lib/sessions";
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
  const [performance, setPerformance] = useState<ModelPerformance[]>([]);
  const [performanceLoading, setPerformanceLoading] = useState(false);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, current, running]);

  // Historical Council reports are persisted separately from ordinary run
  // summaries. Read only completed reports for this session and cap the sample
  // to avoid excessive desktop/IPC work on heavily used installations.
  useEffect(() => {
    let canceled = false;
    if (!current || !open) {
      queueMicrotask(() => { if (!canceled) { setPerformance([]); setPerformanceLoading(false); } });
      return () => { canceled = true; };
    }
    const load = async () => {
      setPerformanceLoading(true);
      try {
        const jobs = (await listSolveJobs("completed"))
          .filter((j) => j.sessionId === current && j.mode === "council")
          .slice(0, 25);
        const saved = await Promise.all(jobs.map(async (job) => {
          try {
            const row = await getCouncilReport(job.id);
            const data = row?.report as Partial<CouncilReport> | undefined;
            return data && Array.isArray(data.candidates) && data.runs && typeof data.runs === "object"
              ? data as CouncilReport : null;
          } catch { return null; }
        }));
        if (!canceled) setPerformance(modelPerformance(saved.filter((r): r is CouncilReport => Boolean(r))));
      } catch {
        if (!canceled) setPerformance([]);
      } finally {
        if (!canceled) setPerformanceLoading(false);
      }
    };
    void load();
    return () => { canceled = true; };
  }, [current, open, running]);

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
          {performanceLoading && <div className="hint">Loading Council performance history…</div>}
          {performance.length > 0 && (
            <details className="history-performance">
              <summary>Saved Council model performance (up to 25 jobs)</summary>
              <div className="hint">Derived from saved execution evidence; generated test passes do not prove general correctness.</div>
              <table style={{ width: "100%", textAlign: "left" }}>
                <thead><tr><th>Model</th><th>Verified</th><th>Failed</th><th>Repairs</th></tr></thead>
                <tbody>{performance.map((m) => (
                  <tr key={m.model}><td>{m.model}</td><td>{m.verified}/{m.executed}</td>
                    <td>{m.failed}</td><td>{m.repairsVerified}/{m.repairAttempts}</td></tr>
                ))}</tbody>
              </table>
            </details>
          )}
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
