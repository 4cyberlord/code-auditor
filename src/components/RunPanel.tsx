"use client";

import { useState } from "react";
import * as bridge from "@/lib/bridge";

/**
 * Running one agent's answer and showing what actually happened.
 *
 * Section 24 calls execution the differentiator, and the reason is narrow but
 * important: four models agreeing is the one failure the consensus engine cannot
 * catch by itself. Agreement measures similarity, not correctness, and four
 * models trained on the same wrong Stack Overflow answer agree beautifully.
 * Running the code is the only step here that can contradict all four at once.
 *
 * The button is a button on purpose. This is code a language model wrote,
 * executing on the user's own machine, and nothing runs until a person decides
 * it should -- however unanimous the panel was.
 */

interface Props {
  language: string;
  code: string;
}

export default function RunPanel({ language, code }: Props) {
  const [result, setResult] = useState<bridge.RunCodeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stdin, setStdin] = useState("");
  const [showStdin, setShowStdin] = useState(false);
  // Shown once per pane, before the first run rather than after it. A caution
  // that appears when the output does is a caution about a decision already made.
  const [acknowledged, setAcknowledged] = useState(false);

  const go = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await bridge.runCode({ language, code, stdin }));
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const verdict = !result
    ? null
    : result.timedOut
      ? { tone: "bad" as const, text: `Still running after ${(result.durationMs / 1000).toFixed(1)}s — stopped` }
      : result.ok
        ? { tone: "good" as const, text: `Ran clean in ${result.durationMs}ms` }
        : { tone: "bad" as const, text: `Exited ${result.exitCode ?? "abnormally"} after ${result.durationMs}ms` };

  if (!acknowledged && !result) {
    return (
      <div className="runbox" data-arm="true">
        <div className="run-head">
          <button className="btn tiny" onClick={() => setAcknowledged(true)} disabled={!code.trim()}>
            Run this code
          </button>
          <span className="chip">{language || "code"}</span>
        </div>
        {/* The honest version of what the sandbox is. Time, memory, processes and
            disk are capped, and the working directory is thrown away -- so a
            runaway cannot take the machine with it. The filesystem and the network
            are not jailed, which means code from a model can read your files and
            call out. Worth knowing before the first press, not after. */}
        <p className="hint" style={{ margin: 0 }}>
          This runs {language ? `the ${language}` : "the"} code a model wrote, on this
          machine. Time, memory and disk are capped and the working folder is deleted
          afterwards — but it can still read your files and reach the network. Have a
          look at it first.
        </p>
      </div>
    );
  }

  return (
    <div className="runbox">
      <div className="run-head">
        <button className="btn tiny" onClick={() => void go()} disabled={busy || !code.trim()}>
          {busy ? "Running…" : result ? "Run Again" : "Run"}
        </button>
        <button className="btn tiny ghost" onClick={() => setShowStdin((v) => !v)}>
          {showStdin ? "No Input" : "Add Input"}
        </button>
        {verdict && (
          <span className="badge" data-tone={verdict.tone}>
            {verdict.text}
          </span>
        )}
        {result?.runtime && <span className="chip">{result.runtime}</span>}
      </div>

      {showStdin && (
        <textarea
          className="field mono"
          rows={2}
          placeholder="Anything the program should read on stdin"
          value={stdin}
          onChange={(e) => setStdin(e.target.value)}
        />
      )}

      {error && <div className="pane-error wrap">{error}</div>}

      {result && (
        <>
          {/* Both streams, always, and labelled. A program that printed the right
              answer to stderr and exited 1 is a different situation from one that
              printed nothing, and collapsing them hides which happened. */}
          {result.stdout.trim() && (
            <>
              <div className="section-label">Output</div>
              <pre className="run-stream">{result.stdout}</pre>
            </>
          )}
          {result.stderr.trim() && (
            <>
              <div className="section-label">Errors</div>
              <pre className="run-stream" data-err="true">
                {result.stderr}
              </pre>
            </>
          )}
          {!result.stdout.trim() && !result.stderr.trim() && (
            <p className="hint" style={{ margin: 0 }}>
              It ran and printed nothing at all.
            </p>
          )}
          {result.truncated && (
            <p className="hint" style={{ margin: 0 }}>
              Output was long, so the middle was dropped — the start and the end are
              both here.
            </p>
          )}
        </>
      )}
    </div>
  );
}
