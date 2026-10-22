import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const FILES = { python: "python-3.15", rust: "rust-1.99", cpp: "cpp-26" };
const PUBLIC = { python: "https://docs.python.org/3.15/", rust: "https://doc.rust-lang.org/", cpp: "https://en.cppreference.com/" };
const cache = new Map();

function load(language) {
  const stem = FILES[language];
  if (!stem) return null;
  if (cache.has(language)) return cache.get(language);
  try {
    const path = fileURLToPath(new URL(`../../docs/api-index/${stem}.json.gz`, import.meta.url));
    const parsed = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
    cache.set(language, parsed);
    return parsed;
  } catch {
    cache.set(language, null);
    return null;
  }
}

/**
 * Symbols that literally appear in the contract/candidate, with a version-pinned
 * documentation link. Capped and specificity-ordered; prose stays on the model.
 */
export function apiLinks(language, text, limit = 6) {
  const index = load(language);
  if (!index) return "";
  const haystack = String(text || "").slice(0, 40_000);
  if (!haystack) return "";
  const hits = [];
  for (const [symbol, value] of Object.entries(index.symbols)) {
    if (symbol.length < 3 || !haystack.includes(symbol)) continue;
    const entry = typeof value === "string" ? { path: value, sig: "" } : value;
    hits.push({ symbol, path: entry.path, sig: entry.sig || "", weight: symbol.length });
  }
  if (!hits.length) return "";
  hits.sort((left, right) => right.weight - left.weight);
  const seen = new Set();
  const rows = [];
  for (const hit of hits) {
    const family = hit.symbol.split(".").slice(0, -1).join(".") || hit.symbol;
    if (seen.has(family) && rows.length >= limit) continue;
    seen.add(family);
    // The signature is the useful half; strip a leading copy of the symbol.
    const sig = hit.sig.replace(new RegExp(`^${hit.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "").slice(0, 120);
    rows.push(`- ${hit.symbol}${sig ? ` — ${sig}` : ""}: ${PUBLIC[language]}${hit.path}`);
    if (rows.length >= limit) break;
  }
  return `Documented ${language} ${index.version} symbols used by this problem:\n${rows.join("\n")}`;
}

export const INDEXED_LANGUAGES = Object.keys(FILES);
