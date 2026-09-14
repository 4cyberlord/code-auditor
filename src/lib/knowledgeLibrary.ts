/**
 * Where the knowledge library is read from.
 *
 * The library has always been a TypeScript array compiled into the bundle:
 * instant, offline, and impossible to change without shipping a build. Two
 * builds, in fact — the app and the worker each carry their own copy, and
 * nothing in a report said which one a run had reasoned from.
 *
 * `intelligence_records` and `intelligence_sources` have existed in the schema
 * since phase 5 for exactly this. This module is the bridge: rows become
 * records, records are cached in memory for the life of a process, and
 * retrieval runs against them exactly as it ran against the array — a
 * millisecond, in process, with no query on the path of a lookup.
 *
 * The compiled pack does not go away; it becomes the fallback. A database that
 * is unreachable, empty, or slow should cost a run its *newest* guidance, never
 * the run itself, so every failure here degrades to the bundle and says so.
 */

import { allKnowledgeRecords, type KnowledgeRecord, type KnowledgeSource } from "./knowledge.ts";

/** A row of `intelligence_records`, as PostgREST returns it. */
export interface RecordRow {
  id: string;
  title: string;
  kind: string;
  summary: string;
  guidance: unknown;
  tags: unknown;
  complexity?: string | null;
  target_runtime_ms?: number | null;
  target_memory_mb?: number | null;
  source_urls?: unknown;
}

/** A row of `intelligence_sources`. */
export interface SourceRow {
  title: string;
  url: string;
  note?: string | null;
  trust?: string | null;
}

export type LibrarySource = "database" | "bundle";

export interface KnowledgeLibrary {
  records: KnowledgeRecord[];
  /** Which shelf these came from — stamped on the run that used them. */
  source: LibrarySource;
  /** Set when the database was tried and could not be used. */
  note: string;
  /** When this was loaded, for the cache and for the record. */
  at: number;
}

const KINDS = new Set(["pattern", "problem", "runtime", "resource"]);
const TRUSTS = new Set(["official", "academic", "reference", "community"]);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

/**
 * Rows to records.
 *
 * A row that cannot become a valid record is dropped rather than repaired: the
 * library is prompt material, and half a record in front of a solver is worse
 * than one fewer record. Sources are joined by URL, which is what
 * `intelligence_sources` is keyed on.
 */
export function recordsFromRows(rows: RecordRow[], sources: SourceRow[] = []): KnowledgeRecord[] {
  const byUrl = new Map<string, KnowledgeSource>();
  for (const s of sources) {
    if (!s?.url?.trim() || !s?.title?.trim()) continue;
    byUrl.set(s.url, {
      title: s.title,
      url: s.url,
      note: s.note ?? "",
      trust: s.trust && TRUSTS.has(s.trust) ? (s.trust as KnowledgeSource["trust"]) : undefined,
    });
  }

  const out: KnowledgeRecord[] = [];
  for (const row of rows) {
    if (!row?.id?.trim() || !row?.title?.trim() || !KINDS.has(row.kind)) continue;
    const guidance = strings(row.guidance);
    if (!guidance.length) continue;
    const record: KnowledgeRecord = {
      id: row.id,
      title: row.title,
      kind: row.kind as KnowledgeRecord["kind"],
      tags: strings(row.tags),
      summary: row.summary ?? "",
      guidance,
    };
    if (row.complexity) record.complexity = row.complexity;
    if (typeof row.target_runtime_ms === "number") record.targetRuntimeMs = row.target_runtime_ms;
    if (typeof row.target_memory_mb === "number") record.targetMemoryMb = row.target_memory_mb;
    const linked = strings(row.source_urls)
      .map((url) => byUrl.get(url))
      .filter((x): x is KnowledgeSource => Boolean(x));
    if (linked.length) record.sources = linked;
    out.push(record);
  }
  return out;
}

/** The pack this build carries, as the fallback library. */
export function bundledLibrary(note = "", at = Date.now()): KnowledgeLibrary {
  return { records: allKnowledgeRecords(), source: "bundle", note, at };
}

export interface LoadOptions {
  /**
   * Reads a table and returns its rows. The caller owns the transport — the
   * worker has a service key and PostgREST, the app will have the server API —
   * so this module needs neither.
   */
  fetchRows?: (table: "intelligence_records" | "intelligence_sources") => Promise<unknown[]>;
  /** How long a loaded library is reused. One process, many jobs. */
  ttlMs?: number;
  /** Force the compiled pack, for a run that must not depend on the database. */
  preferBundle?: boolean;
  now?: number;
}

let cached: KnowledgeLibrary | null = null;

/** Drop the cache. Tests use it; a long-lived worker gets it for free via TTL. */
export function resetKnowledgeCache(): void {
  cached = null;
}

/**
 * The library for this run.
 *
 * Loaded once per process and reused until the TTL expires, because the cost
 * worth avoiding is the round trip, not the search: retrieval over the loaded
 * array is about a millisecond, while a query is tens to hundreds. A library
 * fetched per lookup would be strictly slower than the array it replaced, which
 * is the version of this idea worth not building.
 */
export async function loadKnowledgeLibrary(opts: LoadOptions = {}): Promise<KnowledgeLibrary> {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? 5 * 60_000;

  if (opts.preferBundle) return bundledLibrary("the bundled pack was requested", now);
  if (cached && now - cached.at < ttl) return cached;
  if (!opts.fetchRows) return bundledLibrary("no database transport is configured", now);

  try {
    const [rows, sources] = await Promise.all([
      opts.fetchRows("intelligence_records"),
      opts.fetchRows("intelligence_sources").catch(() => [] as unknown[]),
    ]);
    const records = recordsFromRows((rows ?? []) as RecordRow[], (sources ?? []) as SourceRow[]);
    if (!records.length) {
      // An empty table is the normal state before the seeder has been run, and
      // it must not read as a library of nothing.
      cached = bundledLibrary("the database holds no usable records yet", now);
      return cached;
    }
    cached = { records, source: "database", note: "", at: now };
    return cached;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Not cached: a database that was down a minute ago may be up now, and
    // caching the failure would keep a healthy library out of reach until the
    // process restarts.
    return bundledLibrary(`the database could not be read (${message})`, now);
  }
}
