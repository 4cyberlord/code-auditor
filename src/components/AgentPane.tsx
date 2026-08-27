"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import RunPanel from "./RunPanel";
import { GATEWAY, agentSpec } from "@/lib/models";
import { routeFor, useStore, type AgentSlot } from "@/lib/store";

const STATUS: Record<AgentSlot["status"], { label: string; tone: string }> = {
  idle: { label: "idle", tone: "" },
  queued: { label: "waiting", tone: "live" },
  streaming: { label: "solving", tone: "live" },
  done: { label: "done", tone: "good" },
  error: { label: "failed", tone: "bad" },
  cancelled: { label: "stopped", tone: "warn" },
};

/** The FINAL block is machine-facing; surface it as a summary, not as raw text. */
function stripFinal(text: string): string {
  const i = text.search(/<<<FINAL/i);
  return i === -1 ? text : text.slice(0, i).trimEnd();
}

export default function AgentPane({ agent }: { agent: AgentSlot }) {
  const spec = agentSpec(agent.provider);
  const retry = useStore((s) => s.retry);
  // Asked of the route, not of a vendor key: a router-only pane never has one,
  // and a gateway pane does not need one.
  const hasRoute = useStore(
    (st) => routeFor(agent.provider, st.settings, st.keys, st.gatewayKey) !== null
  );
  const openSettings = useStore((s) => s.setSettingsOpen);

  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the stream, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [agent.text, pinned]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const status = STATUS[agent.status];
  const streaming = agent.status === "streaming" || agent.status === "queued";
  const visible = stripFinal(agent.text);
  const final = agent.final;

  /**
   * The one-line summary under a pane.
   *
   * Models asked not to state an unmeasured runtime often comply by writing
   * "Runtime: not measured. Memory: not measured." into their complexity line.
   * That is correct of them and useless here — the Solution card already says
   * whether anything ran — so it is stripped rather than repeated four times.
   */
  const footFacts = (() => {
    const out: string[] = [];
    if (agent.elapsedMs != null) out.push(`${(agent.elapsedMs / 1000).toFixed(1)}s`);
    if (agent.outputTokens != null) out.push(`${agent.inputTokens ?? "?"} in / ${agent.outputTokens} out`);
    if (final?.confidence != null) out.push(`Confidence ${(final.confidence * 100).toFixed(0)}%`);
    const complexity = (final?.complexity ?? "")
      .replace(/\b(runtime|memory)\s*:\s*not measured\.?/gi, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s.;,]+|[\s.;,]+$/g, "")
      .trim();
    if (complexity) out.push(complexity);
    return out;
  })();

  return (
    <section className="pane" data-disabled={!agent.enabled}>
      <div className="pane-head">
        <span className="dot" style={{ background: spec.accent }} data-pulse={streaming} />
        <span className="pane-title">{spec.label}</span>
        {/* The route belongs next to the model id, not buried in Settings: two
            answers reached over different wires are not quite the like-for-like
            comparison the panel implies they are. */}
        <span
          className="pane-model"
          title={
            agent.viaGateway
              ? `${agent.model} — reached through ${GATEWAY.label}`
              : agent.model
          }
        >
          {agent.viaGateway && <span className="via">↝</span>}
          {agent.model}
        </span>
        <span className="spacer" />
        {agent.status !== "idle" && (
          <span className="badge" data-tone={status.tone || undefined}>
            {status.label}
          </span>
        )}
        {(agent.status === "error" || agent.status === "cancelled" || agent.status === "done") && (
          <button className="btn tiny ghost" onClick={() => retry(agent.id)}>
            Re-run
          </button>
        )}
      </div>

      <div className="pane-body" ref={scroller} onScroll={onScroll}>
        {!agent.enabled ? (
          <div className="empty">
            {spec.vendor} is switched off.
            <br />
            <button className="link" onClick={() => openSettings(true)}>
              Turn it on in Settings
            </button>
          </div>
        ) : agent.status === "error" ? (
          <div className="pane-error wrap">
            {agent.error}
            {/* The remedy depends on the pane, which the Rust side cannot know.
                A vendor pane can drop off the gateway onto its own key; a
                router-only pane has no such fallback, and saying otherwise sends
                someone hunting for a setting that does not exist. */}
            {spec.routerOnly ? (
              <div className="hint" style={{ marginTop: 6 }}>
                {spec.label} is only reachable through {GATEWAY.label}, so there is no
                direct key to fall back to. Add credit, or switch this pane off and use
                one with its own key.
              </div>
            ) : (
              <div className="hint" style={{ marginTop: 6 }}>
                {spec.vendor} can also be reached directly: add a {spec.vendor} key and
                turn the {GATEWAY.label} switch off to bypass the router entirely.
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <button className="btn tiny" onClick={() => openSettings(true)}>
                Open Settings
              </button>
            </div>
          </div>
        ) : agent.status === "idle" ? (
          <div className="empty">
            {hasRoute ? (
              <>Ready. {spec.vendor} will read the image and solve it independently.</>
            ) : (
              <>
                No API key for {spec.vendor} yet.
                <br />
                <button className="link" onClick={() => openSettings(true)}>
                  Add one
                </button>
              </>
            )}
          </div>
        ) : agent.status === "queued" && !visible ? (
          <div className="empty">Thinking…</div>
        ) : (
          <>
            <Markdown text={visible} caret={streaming} />
            {final && (final.answer || final.code) && (
              <div className="answer-card" style={{ marginTop: 12 }}>
                <div className="who">
                  <span className="dot" style={{ background: spec.accent }} />
                  Final answer
                  {final.kind !== "unknown" && <span className="badge">{final.kind}</span>}
                  {!final.wellFormed && (
                    <span className="badge" data-tone="warn" title="No FINAL block was returned; this was reconstructed from the reply.">
                      Inferred
                    </span>
                  )}
                </div>
                {final.answer && <div className="txt">{final.answer}</div>}
                {final.code && (
                  <div style={{ marginTop: 8 }}>
                    <Markdown text={"```" + (final.language || "") + "\n" + final.code + "\n```"} />
                    {/* Only where there is something to run. A research answer
                        with no code should not grow a Run button. */}
                    <RunPanel language={final.language} code={final.code} />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="pane-foot">
        {/* Built as one list with real separators rather than bare siblings
            relying on flex `gap`. The gap only exists on screen: copy the row
            and it came out as "30.9s19260 in / 1295 outconf 99%O(n) time",
            which is what you paste into a bug report. */}
        {footFacts.map((fact, i) => (
          <span key={fact}>
            {i > 0 && <span className="pane-foot-sep" aria-hidden="true">·</span>}
            {fact}
          </span>
        ))}
        <span className="spacer" />
        {!pinned && streaming && (
          <button
            className="btn tiny ghost"
            onClick={() => {
              setPinned(true);
              const el = scroller.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            Follow
          </button>
        )}
      </div>
    </section>
  );
}
