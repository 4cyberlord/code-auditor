"use client";

import { useEffect, useState } from "react";
import { modelPerformance, type CouncilReport, type ModelPerformance } from "@/lib/council";
import { getCouncilReport, listSessions, listSolveJobImages, listSolveJobs, type CouncilReportSummary, type RunSummary, type SolveJob } from "@/lib/sessions";
import { signedUrl } from "@/lib/bridge";
import Markdown from "@/components/Markdown";
import { formatWhen } from "@/lib/when";
import { useStore } from "@/lib/store";

type TimelineItem =
  | { kind: "run"; at: string; run: RunSummary }
  | { kind: "job"; at: string; job: SolveJob };

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
  const [remoteJobs, setRemoteJobs] = useState<SolveJob[]>([]);
  const [remoteSelectedId, setRemoteSelectedId] = useState<string | null>(null);
  const [remoteReport, setRemoteReport] = useState<CouncilReportSummary | null>(null);
  const [remotePreviews, setRemotePreviews] = useState<Array<{ id: string; url: string }>>([]);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>({});
  const remoteSelected = remoteJobs.find((job) => job.id === remoteSelectedId) ?? null;
  const selectedRemoteJobId = remoteSelected?.id;
  const selectedRemoteJobUpdatedAt = remoteSelected?.updatedAt;
  const timeline: TimelineItem[] = [
    ...history.map((run) => ({ kind: "run" as const, at: run.startedAt, run })),
    ...remoteJobs.map((job) => ({ kind: "job" as const, at: job.createdAt, job })),
  ].sort((left, right) => right.at.localeCompare(left.at));

  // Main-app runs and overlay submissions share the same account-scoped
  // history. They are separate persistence records, but one timeline for the
  // person using the app—not two competing histories.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const refresh = async () => {
      try {
        const [jobs, activeSessions, archivedSessions] = await Promise.all([
          listSolveJobs("all"),
          listSessions("active"),
          listSessions("archived"),
        ]);
        if (live) {
          setRemoteJobs(jobs);
          setSessionTitles(Object.fromEntries(
            [...activeSessions, ...archivedSessions].map((session) => [session.id, session.title])
          ));
          setRemoteError(null);
        }
      } catch (err) {
        if (live) setRemoteError(String(err));
      }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [open]);

  useEffect(() => {
    if (!selectedRemoteJobId) return;
    let live = true;
    const load = async () => {
      setRemoteLoading(true);
      setRemoteError(null);
      try {
        const [report, images] = await Promise.all([
          getCouncilReport(selectedRemoteJobId),
          listSolveJobImages(selectedRemoteJobId),
        ]);
        const previews = await Promise.all(images.map(async (image) => {
          try {
            const url = await signedUrl(image.storagePath, 900, image.storageBucket);
            return { id: image.id, url };
          } catch { return null; }
        }));
        if (live) {
          setRemoteReport(report);
          setRemotePreviews(previews.filter((p): p is { id: string; url: string } => p !== null));
        }
      } catch (err) {
        if (live) setRemoteError(String(err));
      } finally {
        if (live) setRemoteLoading(false);
      }
    };
    void load();
    return () => { live = false; };
  }, [selectedRemoteJobId, selectedRemoteJobUpdatedAt]);

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
          {remoteError && <div className="pane-error">{remoteError}</div>}

          {!historyLoading && !timeline.length && !historyError && (
            <div className="empty" style={{ padding: 20 }}>
              No saved work yet. Completed main-app and overlay work appears here together.
            </div>
          )}

          {historyLoading && !timeline.length && (
            <div className="empty" style={{ padding: 20 }}>
              Loading saved work…
            </div>
          )}

          {timeline.length > 0 && (
            <div className="history-list">
              {timeline.map((item) => item.kind === "run" ? (() => {
                const r = item.run;
                const isCurrent = r.id === viewingRunId;
                return <button key={`run:${r.id}`} className="history-row" data-current={isCurrent}
                  disabled={running} title={running ? "Finish the current run first" : "Show this run in the panes"}
                  onClick={() => void openRun(r.id)}>
                  <div className="history-asked" title={r.asked.trim() || undefined}>{r.title || "Captured question"}</div>
                  <div className="history-meta">
                    <span>Main app</span><span>·</span><span>{formatWhen(r.startedAt, zone, "relative")}</span><span>·</span>
                    <span>{r.answered} {r.answered === 1 ? "answer" : "answers"}</span>
                    {r.verdict && <><span>·</span><span className="history-verdict">{r.verdict}</span></>}
                  </div>
                </button>;
              })() : (() => {
                const job = item.job;
                return <button key={`job:${job.id}`} className="history-row" data-current={remoteSelectedId === job.id}
                  onClick={() => { setRemoteSelectedId(remoteSelectedId === job.id ? null : job.id); setRemoteReport(null); setRemotePreviews([]); }}>
                  <div className="history-asked">Overlay · {sessionTitles[job.sessionId] || job.resultSummary || "Captured question"}</div>
                  <div className="history-meta"><span>{formatWhen(job.createdAt, zone, "relative")}</span><span>·</span><span>{job.status.replaceAll("_", " ")}</span></div>
                </button>;
              })())}
            </div>
          )}
          {remoteSelected && (
            <div className="job-detail" aria-label="Overlay solution detail">
              <div className="job-detail-head"><strong>Overlay Council report</strong><button className="btn tiny ghost" onClick={() => setRemoteSelectedId(null)}>Close</button></div>
              {remoteLoading && <div className="hint">Loading saved report…</div>}
              {remotePreviews.length > 0 && <div className="job-images">{remotePreviews.map((image, index) => <img key={image.id} src={image.url} alt={`Captured screenshot ${index + 1}`} />)}</div>}
              {remoteReport?.markdown ? <div className="job-report"><Markdown text={remoteReport.markdown} /></div> : !remoteLoading && <p className="hint">{remoteSelected.error || "The complete report will appear once the cloud worker finishes."}</p>}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
