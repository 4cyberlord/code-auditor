"use client";

import { useEffect, useState } from "react";
import {
  inTauri,
  openScreenRecordingSettings,
  requestScreenRecordingPermission,
  restartForScreenRecordingPermission,
  screenRecordingPermissionStatus,
} from "@/lib/bridge";

type Step = "checking" | "needs-permission" | "restart" | "settings" | "hidden";

/**
 * First-run permission guidance for the native shell. Browser previews do not
 * need, and must not show, a macOS privacy prompt.
 */
export default function ScreenRecordingPermission() {
  const [step, setStep] = useState<Step>(() => inTauri() ? "checking" : "hidden");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;

    let cancelled = false;
    const check = () => {
      void screenRecordingPermissionStatus()
        .then((permission) => { if (!cancelled) setStep(permission.granted ? "hidden" : "needs-permission"); })
        .catch(() => { if (!cancelled) setStep("needs-permission"); });
    };
    check();
    // The overlay helper may earn the grant while this page is open; re-check
    // instead of asking for a restart.
    const timer = window.setInterval(check, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const request = async () => {
    setBusy(true);
    try {
      const permission = await requestScreenRecordingPermission();
      setStep(permission.granted ? "restart" : "settings");
    } catch {
      setStep("settings");
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    setBusy(true);
    await restartForScreenRecordingPermission();
  };

  const openSettings = async () => {
    setBusy(true);
    try {
      await openScreenRecordingSettings();
    } finally {
      setBusy(false);
    }
  };

  if (step === "checking" || step === "hidden") return null;

  const waitingForSettings = step === "settings";
  const readyToRestart = step === "restart";

  return (
    <div className="scrim" role="presentation">
      <section className="modal compact" role="dialog" aria-modal="true" aria-labelledby="screen-recording-title">
        <header>
          <h2 id="screen-recording-title">Enable Screen Recording</h2>
        </header>
        <div className="content">
          {readyToRestart ? (
            <>
              <p>Screen Recording access is approved. Restart Council Editor once to activate it.</p>
              <p className="hint">Your screenshots remain private to this Mac unless you choose to upload them.</p>
            </>
          ) : waitingForSettings ? (
            <>
              <p>macOS has not approved Screen Recording yet.</p>
              <p className="hint">
                Open Screen Recording Settings, enable Council Editor, then return here and restart the app.
              </p>
            </>
          ) : (
            <>
              <p>Council Editor needs Screen Recording permission before it can capture a screen or region.</p>
              <p className="hint">macOS will show its own approval prompt. Council Editor cannot grant this access itself.</p>
            </>
          )}
        </div>
        <footer>
          {!readyToRestart && (
            <button className="btn ghost" type="button" onClick={() => setStep("hidden")} disabled={busy}>
              Not now
            </button>
          )}
          <span className="spacer" />
          {readyToRestart ? (
            <button className="btn primary" type="button" onClick={() => void restart()} disabled={busy}>
              {busy ? "Restarting…" : "Restart Council Editor"}
            </button>
          ) : (
            <>
              {waitingForSettings && (
                <button className="btn" type="button" onClick={() => void openSettings()} disabled={busy}>
                  Open Screen Recording Settings
                </button>
              )}
              <button className="btn primary" type="button" onClick={() => void request()} disabled={busy}>
                {busy ? "Requesting…" : waitingForSettings ? "Check again" : "Allow Screen Recording"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
