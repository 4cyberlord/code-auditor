/**
 * Bounded, server-only documentation retrieval for Council jobs.
 * Official documentation lives in Neon; Supabase holds only the registry locator.
 * Deliberately search indexed titles/paths, not full multi-MB Markdown bodies.
 */
import { canonicalLanguage } from "./languageRegistry.mjs";
import { configuredLanguageRegistries, registriesFromDirectory } from "./externalLanguageSources.mjs";

const cache = new Map();
const pending = new Map();
const MAX_CACHE = 128;
const SUCCESS_TTL = 5 * 60_000;
const FAILURE_TTL = 15_000;
const MAX_RESPONSE = 96 * 1024;
const MAX_CONTEXT = 6500;
const STOP = new Set(["that","this","with","from","into","have","when","then","where","what","your","does","will","using","which","their","about","there","return","solve","write","code","problem","given","should","must","function","class"]);

export function searchTerms(input) {
  return [...new Set((String(input || "").toLowerCase().match(/[a-z][a-z0-9_]{3,23}/g) || [])
    .map(term => term.replace(/_+$/g, ""))
    .filter(term => term.length >= 4))]
    .filter(t => !STOP.has(t)).slice(0, 5);
}
function trimContext(rows, language) {
  const out = [];
  let remaining = MAX_CONTEXT;
  for (const row of rows) {
    if (!row || typeof row.title !== "string" || typeof row.content_md !== "string") continue;
    const text = row.content_md.slice(0, Math.min(2800, remaining));
    const url = typeof row.official_url === "string" && /^https:\/\//.test(row.official_url) ? row.official_url : "";
    const section = `## ${row.title.slice(0,120)} [${language}]\nSource: ${url}\n${text}\n`;
    if (section.length > remaining) break;
    out.push(section);
    remaining -= section.length;
    if (remaining < 400) break;
  }
  return out.join("\n");
}
export function clearOfficialDocsCache() { cache.clear(); pending.clear(); }
export async function fetchOfficialDocDigest(language, query, {
  registryDirectory, environment = process.env, fetchImpl = fetch, now = Date.now()
} = {}) {
  let id;
  try { id = canonicalLanguage(language); } catch { return ""; }
  const words = searchTerms(query);
  if (!words.length) return "";
  const key = id + ":" + words.join(",");
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.value;
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => {
    let value = "";
    try {
      let registries = configuredLanguageRegistries(environment);
      if (!registries.length && typeof registryDirectory === "function")
        registries = registriesFromDirectory(await registryDirectory());
      for (const registry of registries) {
        try {
          const u = new URL(registry.endpoint.href);
          u.pathname = u.pathname.replace(/\/?$/, "/") + "official_doc_topics";
          u.searchParams.set("select", "title,source_path,content_md,official_url");
          u.searchParams.set("language", "eq." + id);
          u.searchParams.set("content_format", "eq.markdown");
          u.searchParams.set("limit", "3");
          u.searchParams.set("or", "(" + words.map(w => "title.ilike.*" + w + "*").join(",") + ")");
          const res = await fetchImpl(u.href, {
            method: "GET", redirect: "error",
            signal: AbortSignal.timeout(2000),
            headers: registry.token ? { Authorization: "Bearer " + registry.token, Accept: "application/json" } : { Accept: "application/json" }
          });
          if (!res.ok || Number(res.headers?.get?.("content-length") || 0) > MAX_RESPONSE) continue;
          const body = await res.text();
          if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE) continue;
          const rows = JSON.parse(body);
          if (!Array.isArray(rows)) continue;
          value = trimContext(rows, id);
          if (value) break;
        } catch { /* Try another source; never block solving on documentation. */ }
      }
    } catch { /* Registry unavailable: bundled guidance is still used. */ }
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { value, until: Date.now() + (value ? SUCCESS_TTL : FAILURE_TTL) });
    return value;
  })();
  pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
}
