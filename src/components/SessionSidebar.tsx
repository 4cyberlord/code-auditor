"use client";

import { useEffect, useState } from "react";
import { formatWhen } from "@/lib/when";
import { useStore } from "@/lib/store";

/**
 * The list of problems, and which one captures attach to.
 *
 * A screenshot on its own is not a question. Three of them — the code, the
 * terminal, the browser — are one question, and this is what says so.
 */
export default function SessionSidebar() {
  const sessions = useStore((s) => s.sessions);
  const status = useStore((s) => s.sessionsStatus);
  const current = useStore((s) => s.currentSessionId);
  const error = useStore((s) => s.sessionsError);
  const loading = useStore((s) => s.sessionsLoading);

  const load = useStore((s) => s.loadSessions);
  const zone = useStore((s) => s.settings.timeZone);
  const create = useStore((s) => s.newSession);
  const select = useStore((s) => s.selectSession);
  const rename = useStore((s) => s.renameSession);
  const archive = useStore((s) => s.archiveSession);
  const remove = useStore((s) => s.removeSession);
  const openSettings = useStore((s) => s.setSettingsOpen);
  const open = useStore((s) => s.settings.railPanel === "sessions");
  const toggleRail = useStore((s) => s.toggleRailPanel);

  // "No database configured" is a setup step, not a fault. Printing it as a red
  // error box next to a Retry button that cannot help was the wrong shape.
  const needsSetup = !!error && /no database is configured/i.test(error);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  // A delete confirmation left showing forever is a foot-gun waiting for a
  // mis-click, so it expires on its own.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const commitRename = async (id: string) => {
    const title = draft.trim();
    setEditing(null);
    if (title) await rename(id, title);
  };

  return (
    <aside className="sessions" data-open={open}>
      {/* The whole header is the handle. A four-pixel chevron is a poor target,
          and there is nothing else this row could mean. */}
      <div
        className="side-head drawer-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => toggleRail("sessions")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleRail("sessions");
          }
        }}
        title={open ? "Collapse" : "Show your sessions"}
      >
        <span className="chev" aria-hidden="true">
          ▾
        </span>
        <h2>Sessions</h2>
        {!open && sessions.length > 0 && (
          <span className="chip">{sessions.length}</span>
        )}
        <span className="spacer" />
        {open && (
          <button
            className="btn tiny"
            onClick={(e) => {
              e.stopPropagation();
              void create();
            }}
            title="Start a fresh session"
          >
            New
          </button>
        )}
      </div>

      {open && (
      <div className="segmented" style={{ margin: "8px 10px 0" }}>
        {(["active", "archived"] as const).map((v) => (
          <button
            key={v}
            data-on={status === v}
            style={{ flex: 1 }}
            onClick={() => void load(v)}
          >
            {v === "active" ? "Active" : "Archived"}
          </button>
        ))}
      </div>
      )}

      {open && (
      <div className="sessions-body">
        {needsSetup && (
          <div className="setup-prompt">
            <p>
              Sessions are stored in Postgres. Add the connection string and the tables
              build themselves — there is no SQL to run by hand.
            </p>
            <button className="btn tiny" onClick={() => openSettings(true)}>
              Set up storage
            </button>
          </div>
        )}

        {error && !needsSetup && <div className="pane-error">{error}</div>}

        {!error && !loading && sessions.length === 0 && (
          <div className="empty" style={{ padding: 24 }}>
            {status === "active"
              ? "No sessions yet. Capture something, or press New."
              : "Nothing archived."}
          </div>
        )}

        {sessions.map((s) => (
          <div
            key={s.id}
            className="session-row"
            data-current={s.id === current}
            onClick={() => void select(s.id)}
            role="button"
            tabIndex={0}
          >
            {editing === s.id ? (
              <input
                className="field"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => void commitRename(s.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename(s.id);
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <>
                <div className="session-title" title={s.title}>
                  {s.title}
                </div>
                <div className="session-meta">
                  {s.screenshotCount} {s.screenshotCount === 1 ? "shot" : "shots"}
                  {s.runCount > 0 && ` · ${s.runCount} ${s.runCount === 1 ? "run" : "runs"}`}
                  {" · "}
                  {formatWhen(s.updatedAt, zone, "relative")}
                </div>

                <div className="session-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn tiny ghost"
                    onClick={() => {
                      setDraft(s.title);
                      setEditing(s.id);
                    }}
                    title="Rename"
                  >
                    Rename
                  </button>
                  <button
                    className="btn tiny ghost"
                    onClick={() => void archive(s.id, status === "active")}
                    title={status === "active" ? "Archive (reversible)" : "Restore to Active"}
                  >
                    {status === "active" ? "Archive" : "Restore"}
                  </button>
                  {confirming === s.id ? (
                    <button
                      className="btn tiny danger"
                      onClick={() => {
                        setConfirming(null);
                        void remove(s.id);
                      }}
                      title="This cannot be undone"
                    >
                      Really delete
                    </button>
                  ) : (
                    <button
                      className="btn tiny ghost"
                      onClick={() => setConfirming(s.id)}
                      title="Delete this session and everything in it"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      )}
    </aside>
  );
}
