"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as bridge from "@/lib/bridge";

/**
 * Supabase connection settings.
 *
 * The Test button matters more than it looks. There are four different failures
 * behind "sessions don't save" — no connection string, a wrong password, an
 * unreachable host, and a database that connects fine but has no tables — and
 * they need four different fixes. This tells them apart before any session code
 * runs on top.
 */
/** Tauri wraps command errors as "Error: ..."; the prefix is noise to a reader. */
function cleanup(message: string): string {
  return message.replace(/^Error:\s*/, "").trim();
}

export default function DatabaseCard() {
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<bridge.DbHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /**
   * Only the newest check may write the result.
   *
   * The card fires a test when it opens and another whenever you press Save, and
   * a failing connection is exactly the slow one: DNS has to time out first. So
   * the opening test could still be hanging while a corrected string saved and
   * connected, and then land afterwards and paint its stale failure over a
   * working connection -- which is how a card can end up reading "connected" with
   * a resolution error printed underneath it.
   *
   * Stamping each attempt and ignoring anything but the latest is the fix. A
   * ref rather than state because it must be read and written synchronously,
   * between renders.
   */
  const attempt = useRef(0);

  const check = useCallback(async () => {
    const mine = ++attempt.current;
    const current = () => mine === attempt.current;

    setBusy(true);
    // Clear both together. Leaving the old error up during a retest is what made
    // it look permanent even while the state underneath had moved on.
    setError(null);
    setHealth(null);
    try {
      const h = await bridge.dbTest();
      if (current()) setHealth(h);
    } catch (err) {
      if (current()) setError(cleanup(String(err)));
    } finally {
      if (current()) setBusy(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    // Captured for the cleanup: reading the ref off the component at teardown is
    // the stale-read the exhaustive-deps rule is warning about.
    const generation = attempt;
    void bridge.dbHasUrl().then((has) => {
      if (!live) return;
      setSaved(has);
      if (has) void check();
    });
    return () => {
      live = false;
      // Anything still in flight belongs to a card that is gone.
      generation.current++;
    };
  }, [check]);

  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    setHealth(null);
    try {
      await bridge.dbSaveUrl(draft.trim());
      setDraft("");
      setSaved(true);
      setNote("Saved to your Keychain.");
      // Saving without checking just moves the discovery of a bad password to
      // the first capture, which is the worst possible moment to find out.
      await check();
    } catch (err) {
      setError(cleanup(String(err)));
      setBusy(false);
    }
  };

  const test = check;

  const repair = async () => {
    const mine = ++attempt.current;
    setBusy(true);
    setError(null);
    setNote(null);
    setHealth(null);
    try {
      const h = await bridge.dbMigrate();
      if (mine === attempt.current) {
        setHealth(h);
        setNote("Tables brought up to date.");
      }
    } catch (err) {
      if (mine === attempt.current) setError(cleanup(String(err)));
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  };

  const forget = async () => {
    // Retires any in-flight check, so a result for the connection just removed
    // cannot arrive and re-populate the card.
    attempt.current++;
    setBusy(true);
    await bridge.dbClearUrl();
    setSaved(false);
    setHealth(null);
    setError(null);
    setNote("Removed.");
    setBusy(false);
  };

  return (
    <div className="provider-card">
      <div className="top">
        <span className="dot" style={{ background: "#3ecf8e" }} />
        <span className="name">Sessions</span>
        <span className="vendor">Supabase Postgres</span>
        {!saved ? (
          <span className="badge" data-tone="warn">
            Not set up
          </span>
        ) : busy ? (
          <span className="badge" data-tone="live">
            Testing
          </span>
        ) : health ? (
          <span className="badge" data-tone="good">
            Connected
          </span>
        ) : error ? (
          <span className="badge" data-tone="bad">
            Not reachable
          </span>
        ) : (
          <span className="badge" data-tone="warn">
            saved, untested
          </span>
        )}
      </div>

      <div className="row">
        <label htmlFor="db-url">Connection</label>
        <div className="with-btn">
          <input
            id="db-url"
            className="field mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              saved
                ? "•••••••••  (paste a new string to replace)"
                : "postgresql://postgres:PASSWORD@db.xxxx.supabase.co:5432/postgres"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
          />
          <button className="btn" onClick={() => void save()} disabled={busy || !draft.trim()}>
            Save
          </button>
          {saved && (
            <button className="btn" onClick={() => void test()} disabled={busy}>
              {busy ? "Testing…" : "Test"}
            </button>
          )}
          {saved && (
            <button className="btn ghost" onClick={() => void forget()} disabled={busy}>
              Forget
            </button>
          )}
        </div>
      </div>

      {/* The diagnosis from Rust is several lines and includes a connection
          string to copy, so it has to keep its line breaks. */}
      {error && <div className="pane-error wrap">{error}</div>}

      {health && (
        <div className="answer-card" style={{ marginTop: 8 }}>
          <div className="who">
            <span className="dot" style={{ background: "var(--good)" }} />
            Connected
            <span className="spacer" />
            <span
              style={{
                fontSize: 10,
                fontWeight: 400,
                color: "var(--text-faint)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {health.serverVersion}
            </span>
          </div>
          <div className="txt" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {health.target}
          </div>
          <div className="txt" style={{ marginTop: 6 }}>
            {health.tablesMissing.length === 0 ? (
              <>
                All {health.tablesFound.length} tables present {"·"} {health.sessionCount}{" "}
                {health.sessionCount === 1 ? "session" : "sessions"} stored
              </>
            ) : (
              <span style={{ color: "var(--warn)" }}>{health.advice}</span>
            )}
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 2 }}>
        <label>Schema</label>
        <div className="with-btn">
          <button
            className="btn ghost"
            onClick={() => void repair()}
            disabled={busy || !saved}
            title="Re-runs the built-in schema. Safe at any time; only creates what is missing."
          >
            Re-apply schema
          </button>
        </div>
      </div>

      <p className="hint">
        {note ??
          "The app creates the tables automatically. Your connection string contains the database password, so it is stored in the macOS Keychain and read only by the app, never the web view."}
      </p>
    </div>
  );
}
