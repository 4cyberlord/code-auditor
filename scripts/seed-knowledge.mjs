#!/usr/bin/env node
/**
 * Publishes the knowledge library to the database the cloud worker reads.
 *
 *   node scripts/seed-knowledge.mjs --dry-run
 *   node scripts/seed-knowledge.mjs
 *   node scripts/seed-knowledge.mjs --folder ~/path/to/knowledge
 *
 * `intelligence_records` and `intelligence_sources` have been in the schema
 * since phase 5 and empty ever since, while the library lived as a TypeScript
 * array that needed a build to change. This moves the array in, so the worker
 * can load it at boot and a record can be edited without shipping anything.
 *
 * Two shelves go in, in this order: the pack compiled into the build, then the
 * markdown files in your knowledge folder, which win on id. That is what makes
 * the Knowledge tab's "write now, publish when ready" true — the app uses a
 * file the moment you save it, and a running cloud job only sees it after this.
 *
 * Idempotent: rows are upserted on their primary keys, so running it twice
 * changes nothing the second time, and running it after editing the pack
 * updates exactly what changed. It never deletes — a record you added in the
 * database and not in the bundle survives a re-seed, because the database is
 * the source of truth once this has run, not a mirror of the code.
 */

import "./lib/config.mjs";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

for (const file of [".development.env", ".env"]) {
  const full = path.join(process.cwd(), file);
  if (!existsSync(full)) continue;
  for (const raw of readFileSync(full, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL_BASE || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(2);
}

const DRY = process.argv.includes("--dry-run");
const c = (code, s) => (process.stdout.isTTY ? `[${code}m${s}[0m` : s);
const b = (s) => c("1", s);
const g = (s) => c("32", s);
const dim = (s) => c("2", s);

async function rest(pathname, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    console.error(`${res.status} on ${pathname}: ${(await res.text()).slice(0, 400)}`);
    process.exit(1);
  }
  return res.status === 204 ? null : res.json();
}

const { allKnowledgeRecords } = await import("../src/lib/knowledge.ts");
const { markdownToRecord } = await import("../src/lib/knowledgeDoc.ts");

const flagValue = (name, fallback = "") => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const folder = (
  flagValue("--folder") ||
  path.join(
    process.env.HOME || "",
    "Library/Application Support/com.charles.councileditor/knowledge"
  )
).replace(/^~(?=\/)/, process.env.HOME || "~");

const library = new Map(allKnowledgeRecords().map((r) => [r.id, r]));
let fromFolder = 0;
const skipped = [];
if (existsSync(folder)) {
  const { readdirSync } = await import("node:fs");
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".md")) continue;
    const markdown = readFileSync(path.join(folder, name), "utf8");
    const { record, problems } = markdownToRecord(markdown);
    // A record with no id or no guidance is a draft, and a draft published to
    // a running job is worse than one that waits. Named, not silently dropped.
    if (!record.id || !record.guidance.length) {
      skipped.push(`${name}: ${problems[0] || "no id or no guidance"}`);
      continue;
    }
    library.set(record.id, record);
    fromFolder += 1;
  }
}

const records = [...library.values()];
const publishedAt = new Date().toISOString();
const platformPublisher = "00000000-0000-0000-0000-000000000000";

// One row per distinct URL. The sources table is keyed by id and unique on url,
// so the id is derived from the url rather than invented per mention — the same
// article cited by three records is one row, not three.
const sources = new Map();
for (const record of records) {
  for (const s of record.sources ?? []) {
    if (!s.url) continue;
    const id = s.url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 80);
    if (!sources.has(s.url)) {
      sources.set(s.url, {
        id,
        title: s.title,
        url: s.url,
        trust: s.trust || "reference",
        note: s.note || "",
        tags: [],
      });
    }
  }
}

const recordRows = records.map((r) => ({
  id: r.id,
  title: r.title,
  kind: r.kind,
  summary: r.summary,
  guidance: r.guidance,
  tags: r.tags,
  complexity: r.complexity ?? null,
  target_runtime_ms: r.targetRuntimeMs ?? null,
  target_memory_mb: r.targetMemoryMb ?? null,
  source_urls: (r.sources ?? []).map((s) => s.url),
  published_by: platformPublisher,
  published_at: publishedAt,
}));

console.log(b("\nPublishing the knowledge library"));
console.log(`  ${recordRows.length} record(s), ${sources.size} source(s)`);
console.log(dim(`  ${fromFolder} from ${folder}`));
console.log(dim(`  the rest from the pack compiled into this build`));
console.log(dim(`  project ${URL_BASE}`));
for (const line of skipped) console.log(dim(`  skipped ${line}`));

const existing = (await rest("intelligence_records?select=id")) ?? [];
const have = new Set(existing.map((r) => r.id));
const added = recordRows.filter((r) => !have.has(r.id)).length;
console.log(`  ${have.size} already in the database — ${added} new, ${recordRows.length - added} updated`);

if (DRY) {
  console.log(dim("\n  --dry-run: nothing was written\n"));
  process.exit(0);
}

const upsert = (table, rows) =>
  rest(table, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });

if (sources.size) await upsert("intelligence_sources?on_conflict=url", [...sources.values()]);
await upsert("intelligence_records", recordRows);

const after = (await rest("intelligence_records?select=id")) ?? [];
console.log(g(`\n  done — ${after.length} record(s) in intelligence_records`));
console.log(
  dim(
    "  The worker loads these at boot and falls back to the compiled pack when\n" +
      "  the database is unreachable. Its knowledge_selected event says which.\n"
  )
);
