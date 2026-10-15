"use client";

import { useEffect, useState } from "react";
import Markdown from "@/components/Markdown";
import { signedUrl } from "@/lib/bridge";
import {
  getCouncilReport,
  listSolveJobImages,
  listSolveJobs,
  type CouncilReportSummary,
  type SolveJob,
} from "@/lib/sessions";
import { useStore } from "@/lib/store";
import { formatWhen } from "@/lib/when";

const PAGE_SIZE = 40;

/**
 * Remote Helper creates its OWN session per batch. Never filter these results
 * against the desktop's current session. Only the authenticated owner's jobs
 * with the server-validated remote-terminal origin belong in this archive.
 *
 * Render in both the top History menu (Story view) and the legacy History rail.
 */
export default function RemoteHistory() {
  const zone = useStore((s) => s.settings.timeZone);
  const [jobs, setJobs] = useState<SolveJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<CouncilReportSummary | null>(null);
  const [previews, setPreviews] = useState<Array<{ id: string; url: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const selected = jobs.find((job) => job.id === selectedId) ?? null;

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const recent = await listSolveJobs("all", {
          origin: "remote-terminal", offset: 0, limit: PAGE_SIZE,
        });
        if (!live) return;
        setJobs((previous) => {
          const ids = new Set(recent.map((job) => job.id));
          return [...recent, ...previous.filter((job) => !ids.has(job.id))]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        });
        setHasMore((previous) => recent.length === PAGE_SIZE || (previous && recent.length > 0));
        setError(null);
      } catch (cause) {
        if (live) setError(String(cause));
      } finally {
        if (live) setInitialLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const load = async () => {
      setDetailLoading(true);
      setError(null);
      try {
        const [saved, images] = await Promise.all([
          getCouncilReport(selected.id),
          listSolveJobImages(selected.id),
        ]);
        const resolved = await Promise.all(images.map(async (image) => {
          try {
            return {
              id: image.id,
              url: await signedUrl(image.storagePath, 900, image.storageBucket),
            };
          } catch { return null; }
        }));
        if (live) {
          setReport(saved);
          setPreviews(resolved.filter((p): p is { id: string; url: string } => p !== null));
        }
      } catch (cause) {
        if (live) setError(String(cause));
      } finally {
        if (live) setDetailLoading(false);
      }
    };
    void load();
    return () => { live = false; };
  }, [selected?.id, selected?.updatedAt]);

  const loadOlder = async () => {
    if (olderLoading || !hasMore) return;
    setOlderLoading(true);
    try {
      const older = await listSolveJobs("all", {
        origin: "remote-terminal", offset: jobs.length, limit: PAGE_SIZE,
      });
      setJobs((previous) => {
        const ids = new Set(previous.map((job) => job.id));
        return [...previous, ...older.filter((job) => !ids.has(job.id))]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      });
      setHasMore(older.length === PAGE_SIZE);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setOlderLoading(false);
    }
  };

  return (
    <section aria-label="Remote solution history">
      <div className="history-inspecting-notice">
        <strong>(R) Remote solutions</strong>
        <span className="hint">Saved across all remote sessions</span>
      </div>
      {error && <p className="pane-error" role="alert">{error}</p>}
      {initialLoading && <p className="hint">Loading remote solutions…</p>}
      {!initialLoading && !jobs.length && !error && (
        <p className="hint">No remote jobs have been submitted with this account yet.</p>
      )}
      {jobs.length > 0 && (
        <div className="history-list">
          {jobs.map((job) => (
            <button
              key={job.id}
              className="history-row"
              data-current={selectedId === job.id}
              onClick={() => {
                setSelectedId(selectedId === job.id ? null : job.id);
                setReport(null);
                setPreviews([]);
              }}
              type="button"
            >
              <div className="history-asked">
                (R) {job.resultSummary || "Captured question"}
              </div>
              <div className="history-meta">
                <span>{formatWhen(job.createdAt, zone, "relative")}</span>
                <span>·</span>
                <span>{job.status.replaceAll("_", " ")}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {hasMore && (
        <button className="btn tiny ghost" type="button" disabled={olderLoading}
          onClick={() => void loadOlder()}>
          {olderLoading ? "Loading…" : "Load older remote solutions"}
        </button>
      )}
      {selected && (
        <div className="job-detail" aria-label="Remote solution detail">
          <div className="job-detail-head">
            <strong>(R) Saved cloud report</strong>
            <button className="btn tiny ghost" type="button" onClick={() => setSelectedId(null)}>
              Close
            </button>
          </div>
          {detailLoading && <p className="hint">Loading saved cloud report…</p>}
          {previews.length > 0 && (
            <div className="job-images">
              {previews.map((image, index) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={image.id} src={image.url} style={{ maxWidth: "100%" }}
                  alt={"Remote screenshot " + (index + 1)} />
              ))}
            </div>
          )}
          {report?.markdown ? (
            <div className="job-report"><Markdown text={report.markdown} /></div>
          ) : !detailLoading && (
            <p className="hint">
              {selected.error || (selected.status === "completed"
                ? "The job is complete, but no saved report could be loaded."
                : "The cloud report will appear when processing finishes.")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
