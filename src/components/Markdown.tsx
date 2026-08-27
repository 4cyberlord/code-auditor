"use client";

import React, { useMemo, useState } from "react";
import { highlight } from "@/lib/highlight";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * A small markdown renderer built for *streaming* text.
 *
 * A library would be heavier and, more to the point, most of them assume the
 * document is complete. Here half the input is a fence that hasn't closed yet,
 * so an unterminated block renders as code rather than as broken prose.
 */

type Block =
  | { t: "code"; lang: string; text: string; open: boolean }
  | { t: "h"; level: number; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "p"; text: string };

function inferredLanguage(text: string): string {
  if (/\b(def|elif|None|True|False|print)\b|:\s*$/.test(text)) return "python";
  if (/\b(func|package|fmt\.Print)\b/.test(text)) return "go";
  if (/\b(fn|let mut|println!|impl|use std::)\b/.test(text)) return "rust";
  if (/\b(public static void|System\.out|extends)\b/.test(text)) return "java";
  if (/\b(SELECT|FROM|WHERE|INSERT INTO|CREATE TABLE)\b/i.test(text)) return "sql";
  if (/\b(const|let|var|function|interface|console\.log|import .* from)\b/.test(text)) return "typescript";
  return "";
}

function looksLikeCode(lines: string[]): boolean {
  const source = lines.join("\n").trim();
  if (!source || source.length > 6000) return false;
  const signals = [
    /[{};]/,
    /(?:=>|===|!==|:=|\+\+|--)/,
    /^\s*(?:const|let|var|function|class|def|fn|func|import|from|return|if|for|while|switch|public|private|SELECT|CREATE)\b/m,
    /\b(?:console\.log|print|println!|System\.out)\s*\(/,
  ];
  const matched = signals.filter((signal) => signal.test(source)).length;
  return matched >= 2;
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      const text = para.join("\n");
      blocks.push(
        looksLikeCode(para)
          ? { t: "code", lang: inferredLanguage(text), text, open: false }
          : { t: "p", text }
      );
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\s*```+\s*([a-zA-Z0-9+#._-]*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1] || "";
      const buf: string[] = [];
      let closed = false;
      i++;
      for (; i < lines.length; i++) {
        if (/^\s*```+\s*$/.test(lines[i])) {
          closed = true;
          break;
        }
        buf.push(lines[i]);
      }
      blocks.push({ t: "code", lang, text: buf.join("\n"), open: !closed });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      blocks.push({ t: "hr" });
      continue;
    }

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      blocks.push({ t: "h", level: h[1].length, text: h[2].trim() });
      continue;
    }

    const q = line.match(/^\s{0,3}>\s?(.*)$/);
    if (q) {
      flushPara();
      const buf = [q[1]];
      while (i + 1 < lines.length && /^\s{0,3}>\s?/.test(lines[i + 1])) {
        buf.push(lines[++i].replace(/^\s{0,3}>\s?/, ""));
      }
      blocks.push({ t: "quote", text: buf.join("\n") });
      continue;
    }

    const ul = line.match(/^\s{0,3}[-*+]\s+(.*)$/);
    const ol = line.match(/^\s{0,3}\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      const items: string[] = [(ul ?? ol)![1]];
      while (i + 1 < lines.length) {
        const nxt = lines[i + 1];
        const m = ordered ? nxt.match(/^\s{0,3}\d+[.)]\s+(.*)$/) : nxt.match(/^\s{0,3}[-*+]\s+(.*)$/);
        if (m) {
          items.push(m[1]);
          i++;
        } else if (/^\s{2,}\S/.test(nxt) && items.length) {
          items[items.length - 1] += " " + nxt.trim();
          i++;
        } else break;
      }
      blocks.push(ordered ? { t: "ol", items } : { t: "ul", items });
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

/**
 * Everything rendered here is model output, and it renders inside a webview that
 * can reach the Tauri IPC bridge. A link is the one place markdown hands an
 * attacker-controlled string to the browser as executable input, so anything that
 * is not plainly a web address is rendered as inert text instead of as an anchor.
 */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/)/i;

/** Inline spans: code, bold, italic, links. Code wins so `**x**` stays literal. */
function inline(src: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // No lookbehind or lookahead here on purpose: WebKit did not support them until
  // Safari 16.4, and one unsupported construct would throw at parse time and take
  // the whole bundle down on an older macOS. Alternation order does the same job,
  // since the ** branch is tried before the * branch.
  const re = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;

  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${keyBase}-i${n++}`;
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3] !== undefined) out.push(<strong key={k}>{inline(m[3], k)}</strong>);
    else if (m[4] !== undefined) out.push(<strong key={k}>{inline(m[4], k)}</strong>);
    else if (m[5] !== undefined) out.push(<em key={k}>{inline(m[5], k)}</em>);
    else if (m[6] !== undefined)
      out.push(
        SAFE_HREF.test(m[7]) ? (
          <a
            key={k}
            href={m[7]}
            target="_blank"
            rel="noreferrer noopener"
            className="link"
            // A plain _blank inside the Tauri webview either does nothing or
            // navigates the app away from itself; hand it to the OS instead.
            onClick={(e) => {
              const href = e.currentTarget.href;
              if (!href.startsWith("http")) return;
              e.preventDefault();
              void openUrl(href).catch(() => window.open(href, "_blank", "noreferrer"));
            }}
          >
            {m[6]}
          </a>
        ) : (
          <span key={k} title={m[7]}>
            {m[6]}
          </span>
        )
      );
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

function CodeBlock({ lang, text, open }: { lang: string; text: string; open: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard denied; the text is selectable anyway */
    }
  };
  // Recomputed only when the code or the language changes. A streaming block
  // re-renders on every token that lands, and re-tokenising the whole thing
  // four panes at a time is exactly the kind of work that makes a stream stutter.
  const tokens = useMemo(() => highlight(text, lang), [text, lang]);

  return (
    <div className="codeblock">
      <header>
        <span>{lang || "code"}{open ? " · writing" : ""}</span>
        <button className="btn tiny ghost" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <pre>
        <code>
          {/* Spans, not an HTML string. Every character in here was written by a
              language model, and `dangerouslySetInnerHTML` is exactly the wrong
              tool to point at that. */}
          {tokens.map((t, i) =>
            t.kind === "plain" ? (
              t.text
            ) : (
              <span key={i} className={`t-${t.kind}`}>
                {t.text}
              </span>
            )
          )}
        </code>
      </pre>
    </div>
  );
}

export default function Markdown({ text, caret = false }: { text: string; caret?: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  return (
    <div className="md">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.t) {
          case "code":
            return <CodeBlock key={key} lang={b.lang} text={b.text} open={b.open} />;
          case "h": {
            const Tag = (`h${Math.min(b.level, 4)}` as unknown) as keyof React.JSX.IntrinsicElements;
            return <Tag key={key}>{inline(b.text, key)}</Tag>;
          }
          case "ul":
            return (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return <blockquote key={key}>{inline(b.text, key)}</blockquote>;
          case "hr":
            return <hr key={key} />;
          default:
            return <p key={key}>{inline(b.text, key)}</p>;
        }
      })}
      {caret && <span className="caret" />}
    </div>
  );
}
