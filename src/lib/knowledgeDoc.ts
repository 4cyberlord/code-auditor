"use client";

/**
 * A knowledge record, as a document a person can write.
 *
 * The library's records are structured — id, kind, tags, a summary, a list of
 * guidance lines, optional targets and sources — and structure is exactly what
 * nobody wants to type into a form with nine fields. So the editor's document
 * *is* markdown, and this module is the translation in both directions: what
 * you write becomes a record, and a record becomes something you can edit.
 *
 * Two decisions shape the format:
 *
 * 1. Front matter for the machine fields only. Id, kind and tags have to be
 *    exact; putting them at the top in `key: value` lines keeps them out of the
 *    prose without inventing syntax for the prose.
 *
 * 2. Headings for the parts that are lists. `## Guidance` and `## Sources` are
 *    how a person already writes a list in markdown, so the parser meets the
 *    writing rather than the other way round.
 *
 * Parsing is forgiving and never throws: a document that is missing something
 * comes back as a record plus a list of problems, and the editor shows those
 * next to the text. A record you cannot save is a message, not an exception.
 */

import type { KnowledgeRecord, KnowledgeSource } from "./knowledge.ts";

export const KINDS = ["pattern", "problem", "runtime", "resource"] as const;
export const TRUSTS = ["official", "academic", "reference", "community"] as const;

export interface ParsedDoc {
  record: KnowledgeRecord;
  /**
   * The collection this record belongs to — "AWS", "Postgres", "Interviews".
   *
   * Kept beside the record rather than inside it: the library's records are a
   * flat set by design (retrieval scores every one of them), and a collection is
   * how a person finds a record, not how a model does. On disk it is the
   * subfolder the file sits in, so the two cannot drift.
   */
  category: string;
  /** Everything wrong with the document, in the order a writer would fix it. */
  problems: string[];
}

/** A title becomes an id when the writer does not supply one. */
export function slugify(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const FRONT = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

function splitSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = "";
  const buffer: string[] = [];
  const flush = () => {
    if (buffer.length) out.set(current, (out.get(current) ?? "") + buffer.join("\n").trim());
    buffer.length = 0;
  };
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].trim().toLowerCase();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

const bullets = (block: string): string[] =>
  (block || "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);

/**
 * `Title — url — trust — note`, with everything after the URL optional.
 *
 * Also accepts markdown links, because a person writing markdown will write a
 * markdown link and being told off for it would be absurd.
 */
function parseSource(line: string): KnowledgeSource | null {
  const link = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*(.*)$/.exec(line);
  let title = "";
  let url = "";
  let rest: string[] = [];
  if (link) {
    title = link[1].trim();
    url = link[2].trim();
    rest = link[3].split(/\s+[—-]\s+/).map((x) => x.trim()).filter(Boolean);
  } else {
    const parts = line.split(/\s+[—-]\s+/).map((x) => x.trim());
    title = parts.shift() ?? "";
    url = parts.shift() ?? "";
    rest = parts;
  }
  if (!url || !/^https?:\/\//.test(url)) return null;
  const trust = rest.find((x) => (TRUSTS as readonly string[]).includes(x.toLowerCase()));
  const note = rest.filter((x) => x !== trust).join(" — ");
  const source: KnowledgeSource = { title: title || url, url, note };
  if (trust) source.trust = trust.toLowerCase() as KnowledgeSource["trust"];
  return source;
}

export function markdownToRecord(markdown: string): ParsedDoc {
  const problems: string[] = [];
  const text = (markdown || "").replace(/\r\n/g, "\n");

  const front = new Map<string, string>();
  const matter = FRONT.exec(text);
  if (matter) {
    for (const line of matter[1].split("\n")) {
      const kv = /^\s*([A-Za-z][A-Za-z ._-]*)\s*:\s*(.*)$/.exec(line);
      if (kv) front.set(kv[1].trim().toLowerCase(), kv[2].trim());
    }
  }
  const body = matter ? text.slice(matter[0].length) : text;

  const titleLine = /^#\s+(.+?)\s*$/m.exec(body);
  const title = (front.get("title") || titleLine?.[1] || "").trim();
  if (!title) problems.push("Give it a title — a `# Heading` at the top, or `title:` in the front matter.");

  const sections = splitSections(body.replace(/^#\s+.+$/m, ""));
  const summary = (sections.get("") ?? "").trim();
  if (!summary) problems.push("Write a summary line under the title: what this record is for, in one or two sentences.");

  const guidance = bullets(sections.get("guidance") ?? "");
  if (!guidance.length) {
    problems.push("Add a `## Guidance` section with at least one bullet — the guidance is what reaches the models.");
  }

  const kindRaw = (front.get("kind") || "").toLowerCase();
  const kind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as KnowledgeRecord["kind"]) : "pattern";
  if (kindRaw && kind !== kindRaw) problems.push(`\`kind: ${kindRaw}\` is not one of ${KINDS.join(", ")} — saved as pattern.`);

  const tags = (front.get("tags") || "")
    .split(/[,\n]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!tags.length) problems.push("Add `tags:` — retrieval matches on them, so a record with none is hard to find.");

  const id = slugify(front.get("id") || title);
  if (!id) problems.push("The id is empty, and a record needs one. Set `id:` explicitly.");

  const category = (front.get("collection") || front.get("category") || "").trim();
  // A collection is also a retrieval signal. Someone who writes "AWS" at the top
  // of twelve records has said something about all twelve that no tag on any of
  // them says, and a question about S3 should find them.
  const searchTags = category && !tags.includes(category.toLowerCase())
    ? [...tags, category.toLowerCase()]
    : tags;

  const record: KnowledgeRecord = { id, title, kind, tags: searchTags, summary, guidance };

  const complexity = front.get("complexity");
  if (complexity) record.complexity = complexity;

  const runtime = front.get("runtime") ?? front.get("runtime target");
  if (runtime != null && runtime !== "") {
    const ms = Number(String(runtime).replace(/ms$/i, "").trim());
    if (Number.isFinite(ms)) record.targetRuntimeMs = ms;
    else problems.push(`\`runtime: ${runtime}\` is not a number of milliseconds.`);
  }

  const memory = front.get("memory") ?? front.get("memory target");
  if (memory != null && memory !== "") {
    const mb = Number(String(memory).replace(/mb$/i, "").trim());
    if (Number.isFinite(mb)) record.targetMemoryMb = mb;
    else problems.push(`\`memory: ${memory}\` is not a number of megabytes.`);
  }

  const sources = bullets(sections.get("sources") ?? "")
    .map(parseSource)
    .filter((s): s is KnowledgeSource => Boolean(s));
  if (sources.length) record.sources = sources;
  const unparsed = bullets(sections.get("sources") ?? "").length - sources.length;
  if (unparsed > 0) {
    problems.push(`${unparsed} source line(s) had no http(s) URL and were dropped.`);
  }

  return { record, category, problems };
}

export function recordToMarkdown(record: KnowledgeRecord, category = ""): string {
  const front = [
    `id: ${record.id}`,
    `kind: ${record.kind}`,
    `tags: ${record.tags.join(", ")}`,
  ];
  if (category.trim()) front.splice(1, 0, `collection: ${category.trim()}`);
  if (record.complexity) front.push(`complexity: ${record.complexity}`);
  if (record.targetRuntimeMs != null) front.push(`runtime: ${record.targetRuntimeMs}`);
  if (record.targetMemoryMb != null) front.push(`memory: ${record.targetMemoryMb}`);

  const out = ["---", ...front, "---", "", `# ${record.title}`, "", record.summary, "", "## Guidance"];
  for (const line of record.guidance) out.push(`- ${line}`);
  if (record.sources?.length) {
    out.push("", "## Sources");
    for (const s of record.sources) {
      out.push(`- ${s.title} — ${s.url}${s.trust ? ` — ${s.trust}` : ""}${s.note ? ` — ${s.note}` : ""}`);
    }
  }
  return out.join("\n") + "\n";
}

/** What a new record starts as: a filled-in example, not an empty page. */
export function blankDocument(): string {
  return [
    "---",
    "id: ",
    "collection: ",
    "kind: pattern",
    "tags: ",
    "complexity: ",
    "---",
    "",
    "# ",
    "",
    "One or two sentences on what this record is for.",
    "",
    "## Guidance",
    "- The specific thing a model should do.",
    "",
    "## Sources",
    "- Title — https://example.com — reference — why it is worth citing",
    "",
  ].join("\n");
}
