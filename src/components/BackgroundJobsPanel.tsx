"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { forgetLocalFile, pokeWorker, signedUrl, uploadScreenshot } from "@/lib/bridge";
import { CLOUD_SOLVER_MAX_IMAGES, sanitizedSettingsSnapshot } from "@/lib/cloudJobs";
import {
  createSolveJob,
  getCouncilReport,
  listSolveJobEvents,
  listSolveJobImages,
  listSolveJobs,
  type CouncilReportSummary,
  type SolveJob,
  type SolveJobEvent,
  type SolveJobImage,
} from "@/lib/sessions";
import { useStore } from "@/lib/store";
import { formatWhen } from "@/lib/when";
import { ProgressiveCouncilResult } from "./ProgressiveCouncilResult";
import { devLog } from "@/lib/devLog";

const statusTone: Record<SolveJob["status"], "good" | "bad" | "warn" | "live"> = {
  queued: "warn",
  running: "live",
  needs_attention: "warn",
  failed: "bad",
  completed: "good",
  cancelled: "bad",
};

function readableStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function excerpt(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

export default function BackgroundJobsPanel() {
  // Part of the rail accordion rather than local state, so opening it closes
  // whatever else was open — and so the choice survives a reload.
  const open = useStore((s) => s.settings.railPanel === "jobs");
  const toggleRail = useStore((s) => s.toggleRailPanel);
  const setOpen = () => toggleRail("jobs");
  const [jobs, setJobs] = useState<SolveJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<SolveJobEvent[]>([]);
  const [images, setImages] = useState<Array<SolveJobImage & { url?: string }>>([]);
  const [urlRefresh, setUrlRefresh] = useState(0);
  const [report, setReport] = useState<CouncilReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const refreshInFlight = useRef(false);
  const failedPreviewUrls = useRef(new Set<string>());
  const lastPreviewRecovery = useRef(0);
  const loadedDetailJobId = useRef<string | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const workspaceImages = useStore((s) => s.images);
  const settings = useStore((s) => s.settings);
  const ensureSession = useStore((s) => s.ensureSession);
  const zone = useStore((s) => s.settings.timeZone);
  const selectSession = useStore((s) => s.selectSession);
  const workerTickUrl = useStore((s) => s.settings.workerTickUrl);
  const workerTickSecret = useStore((s) => s.settings.workerTickSecret);
  const [poking, setPoking] = useState(false);
  const [pokeNote, setPokeNote] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selected) ?? jobs[0] ?? null,
    [jobs, selected]
  );

  /**
   * A job nobody has picked up.
   *
   * Queuing a job and running one are separate processes: the app writes the row
   * and a worker claims it. If no worker is running, the row simply waits — and
   * the panel used to show it sitting at "queued" with nothing to say that
   * nothing was coming for it. Two minutes is well past a 5-second poll, so a
   * job still unclaimed after that is not slow, it is unattended.
   */
  const stalled = useMemo(() => {
    const cutoff = now - 120_000;
    return jobs.filter(
      (job) => job.status === "queued" && !job.claimedAt && new Date(job.createdAt).getTime() < cutoff
    );
  }, [jobs, now]);

  const poke = async () => {
    setPoking(true);
    setPokeNote(null);
    try {
      const result = await pokeWorker(workerTickUrl, workerTickSecret);
      setPokeNote(
        !result
          ? "No worker address is set."
          : result.worked
            ? "The worker took a job."
            : "The worker answered, but had nothing queued to take."
      );
      await refresh();
    } catch (err) {
      setPokeNote(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setPoking(false);
    }
  };

  const refresh = async () => {
    // A slow response must not overlap the next polling tick or manual refresh.
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setLoading(true);
    setError(null);
    devLog("cloud-jobs", "refresh started");
    try {
      const next = await listSolveJobs("all");
      setJobs(next);
      setSelected((current) =>
          current && next.some((job) => job.id === current) ? current : next[0]?.id ?? null
      );
      devLog("cloud-jobs", "refresh completed", { count: next.length });
    } catch (err) {
      setError(String(err));
      devLog("cloud-jobs", "refresh failed", { error: String(err) });
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    // The collapsed rail needs no background network polling. Opening it
    // revalidates the list; the independent helper continues cloud work.
    if (!open) return;
    void refresh();
    const refreshTimer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 15000);
    // Signed previews expire after 15 minutes; renew them before expiry.
    const urlTimer = window.setInterval(() => setUrlRefresh((version) => version + 1), 12 * 60_000);
    // A window can be hidden for hours. Reconcile immediately on return,
    // rather than leaving a completed cloud job stale for another poll cycle.
    const onVisibilityChange = () => {
      if (!document.hidden) {
        void refresh();
        setUrlRefresh((version) => version + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
      window.clearInterval(urlTimer);
    };
  }, [open]);

  const queueCurrent = async () => {
    setQueueing(true);
    setError(null);
    devLog("cloud-jobs", "queue current started", { images: workspaceImages.length });
    try {
      if (!workspaceImages.length) throw new Error("Load at least one screenshot before queuing a cloud job.");
      if (workspaceImages.length > CLOUD_SOLVER_MAX_IMAGES) {
        throw new Error(`A cloud job can hold at most ${CLOUD_SOLVER_MAX_IMAGES} screenshots.`);
      }
      // The Rust bridge obtains a scoped signed upload URL from the authenticated server API.
      // A service-role key must not be required on the desktop.
      const sessionId = await ensureSession();
      if (!sessionId) throw new Error("Set up the Supabase database connection before queuing cloud jobs.");

      // Durable submission journal. A lost jobs.create reply MUST NOT create a new job.
      const journalKey = "council-editor.pending-solve.v1";
      // Content hashes avoid placing multi-megabyte base64 images in localStorage.
      const signatures = await Promise.all(workspaceImages.map(async (image) => {
        const bytes = new TextEncoder().encode(image.base64);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        return [image.name, image.mime, hash, image.localPath ?? ""];
      }));
      const signature = JSON.stringify(signatures);
      type JobImage = { position: number; storageBucket: string; storagePath: string;
        fileName: string; bytes: number; mime: string; width: number | null; height: number | null };
      type Journal = { submissionId: string; sessionId: string; signature: string;
        settingsSnapshot: Record<string, unknown>; images: JobImage[] };
      let prior: Journal | null = null;
      try { prior = JSON.parse(localStorage.getItem(journalKey) ?? "null") as Journal | null; }
      catch { /* bad journal is not trusted */ }
      if (prior && prior.signature !== signature) {
        throw new Error("An earlier submission is unresolved. Restore its screenshots and retry before starting a different batch.");
      }
      const submission: Journal = prior ?? {
        submissionId: crypto.randomUUID(), sessionId, signature,
        settingsSnapshot: sanitizedSettingsSnapshot({ ...settings }), images: [],
      };
      if (submission.sessionId !== sessionId) {
        throw new Error("Submission account/session changed; recover the earlier batch instead of silently switching ownership.");
      }
      const persist = () => localStorage.setItem(journalKey, JSON.stringify(submission));
      persist();
      const survived = new Map<string, boolean>();
      for (const [position, image] of workspaceImages.entries()) {
        if (!submission.images[position]) {
          const uploaded = await uploadScreenshot({
            sessionId: submission.sessionId, fileName: image.name,
            mime: image.mime, data: image.base64,
            submissionId: submission.submissionId, position,
            backend: settings.imageStorage,
          });
          submission.images[position] = {
            position, storageBucket: uploaded.bucket, storagePath: uploaded.path,
            fileName: image.name, bytes: uploaded.bytes, mime: image.mime,
            width: image.sourceWidth ?? null, height: image.sourceHeight ?? null,
          };
          persist();
        }
        if (image.localPath && !survived.has(image.localPath)) survived.set(image.localPath, true);
      }
      const jobId = await createSolveJob({
        submissionId: submission.submissionId, sessionId: submission.sessionId,
        settingsSnapshot: submission.settingsSnapshot, images: submission.images,
      });
      localStorage.removeItem(journalKey);
      devLog("cloud-jobs", "job created", { jobId, images: submission.images.length });
      for (const [path, ok] of survived) {
        if (ok) void forgetLocalFile(path);
      }
      await refresh();
      setSelected(jobId);
    } catch (err) {
      setError(String(err));
      devLog("cloud-jobs", "queue current failed", { error: String(err) });
    } finally {
      setQueueing(false);
    }
  };

  const selectedDetailId = selectedJob?.id;
  const selectedDetailStatus = selectedJob?.status;
  const selectedDetailVersion = selectedJob?.updatedAt;

  useEffect(() => {
    if (!open) return;
    if (!selectedDetailId) {
      loadedDetailJobId.current = null;
      queueMicrotask(() => {
        setEvents([]);
        setImages([]);
        setReport(null);
      });
      return;
    }
    let live = true;
    // Only clear when the selected job changes. URL renewal and status updates
    // should preserve valid previews/reports while fresh data is in flight.
    const changedJob = loadedDetailJobId.current !== selectedDetailId;
    loadedDetailJobId.current = selectedDetailId;
    queueMicrotask(() => {
      if (!live) return;
      setError(null);
      if (changedJob) {
        setEvents([]);
        setImages([]);
        setReport(null);
      }
    });
    devLog("cloud-jobs", "detail load started", { jobId: selectedDetailId });
    // Each detail endpoint recovers independently: a temporary report failure
    // must not hide available screenshots, and a signing error must not hide events.
    void Promise.allSettled([
      listSolveJobEvents(selectedDetailId),
      listSolveJobImages(selectedDetailId),
      getCouncilReport(selectedDetailId),
    ]).then(async ([eventResult, imageResult, reportResult]) => {
      if (!live) return;
      if (eventResult.status === "fulfilled") setEvents(eventResult.value);
      if (reportResult.status === "fulfilled") setReport(reportResult.value);
      if (imageResult.status === "fulfilled") {
        const withUrls = await Promise.all(
          imageResult.value.map(async (image) => {
            try {
              return { ...image, url: await signedUrl(image.storagePath, 900, image.storageBucket) };
            } catch {
              return image;
            }
          })
        );
        if (live) setImages(withUrls);
      }
      if (!live) return;
      const failures = [eventResult, imageResult, reportResult]
        .filter((result) => result.status === "rejected")
        .map((result) => String((result as PromiseRejectedResult).reason));
      if (failures.length) setError(`Could not load all cloud job details: ${failures.join("; ")}`);
      devLog("cloud-jobs", "detail load settled", {
        jobId: selectedDetailId,
        failedRequests: failures.length,
      });
    });
    return () => {
      live = false;
    };
  // A refreshed listing creates new objects even if the job did not change.
  // Depend on its identity/version, not its object reference: this prevents
  // re-signing every image URL and reloading the report every 15 seconds.
  }, [open, selectedDetailId, selectedDetailStatus, selectedDetailVersion, urlRefresh]);

  // The Council writes its verified preferred-language answer before
  // optional porting completes. Refresh just the small report JSON while the
  // cloud job continues; no screenshot re-fetch or re-signing on these ticks.
  useEffect(()=>{
    if(!open||!selectedDetailId||selectedDetailStatus!=="running")return;
    let live=true;let busy=false;
    const poll=async()=>{
      if(!live||busy||document.hidden)return;
      busy=true;
      try{
        const latest=await getCouncilReport(selectedDetailId);
        if(live&&latest)setReport(latest);
      }catch{/* jobs/events refresh reports connection errors */}
      finally{busy=false}
    };
    void poll();
    const id=window.setInterval(()=>{void poll()},5000);
    return ()=>{live=false;window.clearInterval(id)};
  },[open,selectedDetailId,selectedDetailStatus]);

  // Report rows can be updated after each language translation finishes while
  // solve_jobs remains in the same 'porting' phase. Refresh only the JSON
  // report while running; never re-sign or re-read screenshot assets here.
  useEffect(() => {
    if (!open || !selectedDetailId || selectedDetailStatus !== "running") return;
    let live = true;
    let busy = false;
    const refreshVerifiedResult = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const updated = await getCouncilReport(selectedDetailId);
        if (live && updated) setReport(updated);
      } catch (error) {
        devLog("cloud-jobs", "verified result refresh failed", { error: String(error) });
      } finally {
        busy = false;
      }
    };
    const refreshTimer = window.setInterval(() => void refreshVerifiedResult(), 6000);
    return () => { live = false; window.clearInterval(refreshTimer); };
  }, [open, selectedDetailId, selectedDetailStatus]);

  return (
    <section className="background-jobs" data-open={open}>
      <div
        className="side-head drawer-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen();
          }
        }}
        title={open ? "Collapse" : "Show background jobs"}
      >
        <span className="chev" aria-hidden="true">
          ▾
        </span>
        <h2>Cloud Jobs</h2>
        {!open && jobs.length > 0 && <span className="chip">{jobs.length}</span>}
        <span className="spacer" />
        {open && (
          <>
          <button
            className="btn tiny ghost"
            disabled={queueing}
            onClick={(e) => {
              e.stopPropagation();
              void queueCurrent();
            }}
          >
            Queue current
          </button>
          <button
            className="btn tiny"
            disabled={loading}
            onClick={(e) => {
              e.stopPropagation();
              void refresh();
            }}
          >
            Refresh
          </button>
          </>
        )}
      </div>

      {open && (
        <div className="background-jobs-body">
          {error && <div className="pane-error">{error}</div>}

          {!error && !loading && jobs.length === 0 && (
            <div className="empty">No cloud jobs yet.</div>
          )}

          {/* The one thing this panel could not previously tell you. */}
          {stalled.length > 0 && (
            <div className="job-stalled">
              <p>
                {stalled.length === 1 ? "One job has" : `${stalled.length} jobs have`} been waiting
                over two minutes with nothing to run {stalled.length === 1 ? "it" : "them"}. Cloud
                jobs are processed by the worker, which runs separately from this app.
              </p>
              {workerTickUrl.trim() ? (
                <button className="btn tiny" disabled={poking} onClick={() => void poke()}>
                  {poking ? "Asking…" : "Ask the Worker to Take One"}
                </button>
              ) : (
                <p className="hint">
                  Start it with <span className="mono">npm run worker:watch</span>, or set a worker
                  address in Settings to nudge one from here.
                </p>
              )}
              {pokeNote && <p className="hint">{pokeNote}</p>}
            </div>
          )}

          {jobs.length > 0 && (
            <div className="job-list">
              {jobs.slice(0, 8).map((job) => (
                <button
                  key={job.id}
                  className="job-row"
                  data-current={job.id === selectedJob?.id}
                  onClick={() => setSelected(job.id)}
                >
                  <span>
                    <span className="job-title">{readableStatus(job.progressPhase || job.status)}</span>
                    <span className="job-meta">{formatWhen(job.updatedAt, zone, "relative")}</span>
                  </span>
                  <span className="badge" data-tone={statusTone[job.status]}>
                    {readableStatus(job.status)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {selectedJob && (
            <div className="job-detail">
              <div className="job-detail-head">
                <span className="mono small">{selectedJob.id.slice(0, 8)}</span>
                <button
                  className="btn tiny ghost"
                  onClick={() => void selectSession(selectedJob.sessionId)}
                >
                  Open session
                </button>
              </div>

              {images.length > 0 && (
                <div className="job-images">
                  {images.map((image) =>
                    image.url ? (
                      <img
                        key={image.id}
                        src={image.url}
                        alt={image.fileName}
                        onError={() => {
                          // An expired or revoked signed URL can fail before its
                          // scheduled renewal. Refresh once per failed URL and
                          // throttle repeated failures to avoid retry storms.
                          if (!image.url || failedPreviewUrls.current.has(image.url)) return;
                          failedPreviewUrls.current.add(image.url);
                          const now = Date.now();
                          if (now - lastPreviewRecovery.current < 30_000) return;
                          lastPreviewRecovery.current = now;
                          setUrlRefresh((version) => version + 1);
                        }}
                      />
                    ) : (
                      <div key={image.id} className="job-image-missing">
                        {image.position + 1}
                      </div>
                    )
                  )}
                </div>
              )}

              {report ? (
                <div className="job-report">
                  <div className="job-title">{report.winner || "Council report"}</div>
                  <p>{excerpt(report.synthesis || report.markdown)}</p>
                  <ProgressiveCouncilResult report={report} processing={selectedJob.status==="running"} />
                </div>
              ) : selectedJob.error ? (
                <div className="pane-error">{selectedJob.error}</div>
              ) : null}

              <div className="job-events">
                {events.slice(-6).map((event) => (
                  <div className="job-event" key={event.id} data-level={event.level}>
                    <span>{event.phase}</span>
                    <p>{event.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
