#!/usr/bin/env node
/**
 * Bounded, incremental mirror of the three user-supplied static documentation
 * trees into Council Editor's dedicated Cloudflare R2 bucket.
 * GitHub OIDC authenticates to the Cloudflare upload Worker; no R2 secrets.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const origin = "http://144.24.31.129";
const prefixPaths = [
  "/offline-docs/python-3.15.0/python-3.15-docs-html/",
  "/offline-docs/rust-1.99.0/",
  "/offline-docs/cpp-26-wg21-n5050/html/",
];
const endpoint = "https://council-offline-html-upload.council-docs-r2-2f1fd544.workers.dev/upload-batch";
const audience = "council-language-docs-r2-upload-v1";
const inventoryEndpoint = "https://council-language-docs-inventory.council-docs-r2-2f1fd544.workers.dev/inventory";
const alreadyStored = new Set();
let skipped = 0;
const maxFiles = 160000;
const downloadConcurrency = 24;
const uploadConcurrency = 7;
const maxFileBytes = 20 * 1024 * 1024;
const maxBatchBytes = 7 * 1024 * 1024;
const maxBatchFiles = 30;
const seen = new Set();
const queue = [];
const downloading = new Map();
const uploading = new Set();
const errors = [];
const counts = Object.fromEntries(prefixPaths.map(p => [p, 0]));
const uploaded = { files: 0, batches: 0 };
let batch = [];
let batchBytes = 0;
let batchCounter = 0;
let credential = "";
let credentialUntil = 0;
let credentialPending;

function enqueue(ref, base) {
  if (!ref || /^(?:#|data:|mailto:|javascript:)/i.test(ref)) return;
  let target;
  try { target = new URL(ref.trim().replaceAll("&amp;", "&"), base); }
  catch { return; }
  if (target.origin !== origin) return;
  target.search = "";
  target.hash = "";
  const pathname = decodeURI(target.pathname);
  if (!prefixPaths.some(p => pathname.startsWith(p))) return;
  if (seen.has(target.href) || seen.size >= maxFiles) return;
  seen.add(target.href);
  queue.push(target.href);
}

function extractLinks(bytes, currentUrl, filePath) {
  const contents = bytes.toString("utf8");
  const results = [];
  if (/\.(?:html?|xhtml)$/i.test(filePath) || !path.extname(filePath)) {
    const attributes = /(?:href|src|poster|data-src)\s*=\s*(["'])(.*?)\1/gi;
    for (const match of contents.matchAll(attributes)) results.push(match[2]);
    const srcset = /srcset\s*=\s*(["'])(.*?)\1/gi;
    for (const match of contents.matchAll(srcset)) {
      for (const item of match[2].split(",")) results.push(item.trim().split(/\s+/)[0]);
    }
    for (const match of contents.matchAll(/<meta[^>]*content\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
      const redirect = match[2].match(/url\s*=\s*([^;\s]+)/i);
      if (redirect) results.push(redirect[1]);
    }
  }
  if (/\.(?:css|html?|xhtml)$/i.test(filePath)) {
    for (const match of contents.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) results.push(match[1]);
    for (const match of contents.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/gi)) results.push(match[1]);
  }
  return results;
}

async function fetchOne(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; CouncilDocsMirror/1.0)" },
        signal: AbortSignal.timeout(24000),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > maxFileBytes) throw new Error("File too large");
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxFileBytes) throw new Error("File too large");
      const filePath = decodeURI(new URL(url).pathname);
      const links = extractLinks(bytes, url, filePath);
      return { url, filePath, bytes, links };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  return { url, error: String(lastError).slice(0, 200) };
}

async function oidcToken() {
  if (credential && Date.now() < credentialUntil) return credential;
  if (credentialPending) return credentialPending;
  credentialPending = (async () => {
    const location = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const access = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!location || !access) throw new Error("GitHub OIDC permission unavailable");
    const u = new URL(location);
    u.searchParams.set("audience", audience);
    const { stdout } = await run("curl", [
      "--fail", "--silent", "--show-error", "--max-time", "25",
      "-H", "Authorization: Bearer " + access, u.toString(),
    ], { maxBuffer: 15000 });
    credential = JSON.parse(stdout).value;
    credentialUntil = Date.now() + 110000;
    return credential;
  })();
  try { return await credentialPending; }
  finally { credentialPending = undefined; }
}

async function sendBatch(files) {
  const manifest = { files: files.map(f => ({
    path: f.key, size: f.bytes.length,
    sha256: createHash("sha256").update(f.bytes).digest("hex"),
  })) };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const packed = Buffer.concat([length, bytes, ...files.map(f => f.bytes)]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "council-docs-"));
  const tempFile = path.join(dir, "batch.bin");
  try {
    await writeFile(tempFile, packed);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const token = await oidcToken();
        const { stdout } = await run("curl", [
          "--fail-with-body", "--silent", "--show-error", "--location",
          "--max-time", "150", "--user-agent", "Mozilla/5.0",
          "-X", "POST", "-H", "Authorization: Bearer " + token,
          "-H", "Content-Type: application/octet-stream",
          "--data-binary", "@" + tempFile, endpoint,
        ], { maxBuffer: 500000 });
        const response = JSON.parse(stdout);
        if (!response.ok || response.count !== files.length) {
          throw new Error("R2 rejected batch: " + stdout.slice(0, 300));
        }
        uploaded.files += files.length;
        uploaded.batches++;
        if (uploaded.files % 500 < files.length) {
          console.log("R2 progress: " + uploaded.files + " files in " + uploaded.batches + " batches");
        }
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function flush(force = false) {
  if (!batch.length) return;
  if (!force && batch.length < maxBatchFiles && batchBytes < maxBatchBytes) return;
  const files = batch;
  batch = [];
  batchBytes = 0;
  const job = sendBatch(files).catch(e => {
    errors.push("Upload failure: " + String(e).slice(0, 250));
  }).finally(() => uploading.delete(job));
  uploading.add(job);
  if (uploading.size >= uploadConcurrency) await Promise.race(uploading);
}

function start(url) {
  const job = fetchOne(url);
  downloading.set(url, job);
}

async function loadPreviouslyStored() {
  let cursor;
  for (let i=0;i<250;i++) {
    const u=new URL(inventoryEndpoint);
    if(cursor)u.searchParams.set("cursor",cursor);
    const response=await fetch(u,{headers:{"user-agent":"Mozilla/5.0"},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error("R2 inventory HTTP "+response.status);
    const result=await response.json();
    for(const k of result.keys||[])alreadyStored.add(k);
    cursor=result.cursor;
    if(!cursor)break;
  }
  console.log("Resume inventory: "+alreadyStored.size+" files already on R2");
}
async function main() {
  try { await loadPreviouslyStored(); }
  catch(e) { console.warn("Inventory lookup failed, will safely re-upload:", String(e).slice(0,220)); }
  for (const prefix of prefixPaths) enqueue("index.html", origin + prefix);
  const started = Date.now();
  console.log("Crawling " + prefixPaths.length + " language documentation roots");
  while (queue.length || downloading.size) {
    while (queue.length && downloading.size < downloadConcurrency) {
      start(queue.shift());
    }
    const item = await Promise.race(downloading.values());
    downloading.delete(item.url);
    if (item.error) {
      if (errors.length < 100) errors.push(item.url + ": " + item.error);
      continue;
    }
    for (const ref of item.links) enqueue(ref, item.url);
    const prefix = prefixPaths.find(p => item.filePath.startsWith(p));
    if (!prefix) continue;
    counts[prefix]++;
    const key=item.filePath.slice(1);
    if (alreadyStored.has(key)) skipped++;
    else {
      batch.push({ key, bytes: item.bytes });
      batchBytes += item.bytes.length;
      await flush();
    }
    if ((counts[prefixPaths[0]] + counts[prefixPaths[1]] + counts[prefixPaths[2]]) % 1000 === 0) {
      console.log("Crawled: " + JSON.stringify(counts) + "; discovered: " + seen.size);
    }
  }
  await flush(true);
  await Promise.all(uploading);
  const outcome = {
    elapsed_seconds: Math.round((Date.now() - started) / 1000),
    discovered: seen.size, crawled: counts, existing_skipped: skipped, uploaded: uploaded.files,
    batches: uploaded.batches, errors: errors.slice(0, 100),
  };
  console.log("FINAL REPORT " + JSON.stringify(outcome));
  if ((uploaded.files + skipped) === 0 || prefixPaths.some(p => !counts[p]) ||
      (uploaded.files + skipped) !== Object.values(counts).reduce((a, b) => a + b, 0) ||
      errors.length) {
    process.exitCode = 1;
  }
}
main().catch(e => { console.error("Fatal mirror error", e); process.exitCode = 1; });
