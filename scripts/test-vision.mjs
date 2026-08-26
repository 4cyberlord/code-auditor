#!/usr/bin/env node
/**
 * Does the Cloud Vision key actually work?
 *
 * Run this before wiring anything to it:
 *
 *   node scripts/test-vision.mjs
 *
 * The key is found in this order: the GOOGLE_VISION_KEY environment variable, a
 * first argument, then the macOS Keychain entry the app itself uses. It is never
 * printed — only a masked form, enough to tell two keys apart and not enough to
 * use one.
 *
 * The test is deliberately not "did it return 200". It sends a picture of a
 * known Python function and checks that what comes back is that function, laid
 * out the way it was on screen. A key that authenticates but transcribes
 * indentation wrong would pass a status check and break every Python problem the
 * app is ever given.
 *
 * The assembly below is a port of `assemble()` in src-tauri/src/vision.rs. That
 * is the point: this exercises the same reconstruction the app will do, against
 * a real response, so a difference between what you see here and what the app
 * produces is a bug rather than a mystery.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Must match keychain.rs, or this tests a key the app will never read.
const KEYCHAIN_SERVICE = "com.charles.codeauditor";
const KEYCHAIN_ACCOUNT = "googlevision";

const EXPECTED = [
  "def two_sum(nums, target):",
  "    seen = {}",
  "    for i, n in enumerate(nums):",
  "        if target - n in seen:",
  "            return [seen[target - n], i]",
  "        seen[n] = i",
  "    return []",
];

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failed = 0;
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? g("ok  ") : r("FAIL")} ${name}${cond || !extra ? "" : "  " + extra}`);
  if (!cond) failed++;
};

// ------------------------------------------------------------------- key

function findKey() {
  if (process.env.GOOGLE_VISION_KEY?.trim()) {
    return { key: process.env.GOOGLE_VISION_KEY.trim(), from: "GOOGLE_VISION_KEY" };
  }
  const arg = process.argv[2]?.trim();
  if (arg) return { key: arg, from: "the command line" };
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (out) return { key: out, from: "the app's Keychain entry" };
  } catch {
    // No entry, or not macOS. Reported by the caller, not here.
  }
  return null;
}

const mask = (k) => (k.length <= 12 ? "•".repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`);

// -------------------------------------------------------------- assembly

/** Median, so one mis-boxed word cannot skew every indent. See vision.rs. */
function charWidth(words) {
  const w = words
    .filter((x) => x.text && x.right > x.left)
    .map((x) => (x.right - x.left) / [...x.text].length)
    .filter((n) => n > 0.5)
    .sort((a, b) => a - b);
  return w.length ? w[Math.floor(w.length / 2)] : 8;
}

function assemble(words) {
  if (!words.length) return { text: "", unsure: [], confidence: 0, words: 0 };

  const lines = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (w.endsLine) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length) lines.push(cur);

  const cw = charWidth(words);
  const margin = Math.min(...lines.map((l) => l[0].left));

  const text = lines
    .map((line) => {
      const raw = (line[0].left - margin) / cw;
      const indent = raw < 0.34 ? 0 : Math.min(64, Math.round(raw));
      return " ".repeat(indent) + line.map((w) => w.text).join(" ");
    })
    .join("\n")
    .trimEnd();

  const unsure = [
    ...new Set(
      words
        .filter((w) => w.confidence > 0 && w.confidence < 0.8)
        .map((w) => `"${w.text}" (${Math.round(w.confidence * 100)}% sure)`)
    ),
  ].sort();

  const scored = words.map((w) => w.confidence).filter((c) => c > 0);
  const confidence = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : 0;

  return { text, unsure, confidence, words: words.length };
}

/** Flattens the page/block/paragraph/word/symbol tree. See vision.rs. */
function flatten(full) {
  const out = [];
  for (const page of full.pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const w of para.words ?? []) {
          const text = (w.symbols ?? []).map((s) => s.text ?? "").join("");
          if (!text) continue;
          const brk = w.symbols?.at(-1)?.property?.detectedBreak?.type ?? "";
          const xs = (w.boundingBox?.vertices ?? []).map((v) => v.x ?? 0);
          out.push({
            text,
            left: xs.length ? Math.min(...xs) : 0,
            right: xs.length ? Math.max(...xs) : 0,
            confidence: w.confidence ?? 0,
            // HYPHEN is a wrapped word, not a line end.
            endsLine: brk === "LINE_BREAK" || brk === "EOL_SURE_SPACE",
          });
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ diagnose

function diagnose(status, body) {
  const msg = (body?.error?.message ?? "").toString();
  const low = msg.toLowerCase();
  if (low.includes("api key not valid") || low.includes("api_key_invalid")) {
    return "That key was rejected. It must be a Google Cloud API key from the same project that has the Vision API enabled.";
  }
  if (low.includes("has not been used") || low.includes("is disabled")) {
    return "The Vision API is not enabled on that project. Enable it in the console, wait a minute, and run this again.";
  }
  if (low.includes("billing")) {
    return "That project has no billing account. Vision is free for the first 1,000 images a month, but the project still needs billing enabled.";
  }
  if (low.includes("quota") || status === 429) {
    return `Quota or rate limit reached: ${msg}`;
  }
  if (low.includes("permission") || status === 403) {
    return `Permission denied: ${msg || "the key may be restricted to other APIs, or to referrer/IP rules this machine does not match."}`;
  }
  return msg || `HTTP ${status} with no message.`;
}

// ---------------------------------------------------------------------- run

const found = findKey();
if (!found) {
  console.error(r("\nNo Cloud Vision key found.\n"));
  console.error("Looked in, in order:");
  console.error("  1. $GOOGLE_VISION_KEY");
  console.error("  2. the first argument to this script");
  console.error(`  3. Keychain: service "${KEYCHAIN_SERVICE}", account "${KEYCHAIN_ACCOUNT}"`);
  console.error("\nEither save it in the app (Settings → Models → Cloud Vision), or run:");
  console.error(dim("  node scripts/test-vision.mjs YOUR_KEY_HERE\n"));
  process.exit(2);
}

const png = readFileSync(join(HERE, "vision-fixture.png"));
console.log(`\nKey ${mask(found.key)} from ${found.from}`);
console.log(`Fixture: ${png.length} bytes, ${EXPECTED.length} lines of Python\n`);

const started = Date.now();
let res, body;
try {
  res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(found.key)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: png.toString("base64") },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["en"] },
          },
        ],
      }),
    }
  );
  // Read as text first. A proxy, a captive portal or a corporate TLS box
  // answers with HTML, and letting that surface as a JSON parse error hides the
  // actual problem behind "Unexpected token '<'".
  const raw = await res.text();
  try {
    body = JSON.parse(raw);
  } catch {
    console.error(r(`\nCloud Vision did not answer with JSON (HTTP ${res.status}).`));
    console.error(dim(raw.slice(0, 300)));
    console.error(
      "\nThat is almost always something between you and Google — a proxy, a VPN, or a" +
        "\nnetwork that blocks googleapis.com — rather than a problem with the key.\n"
    );
    process.exit(1);
  }
} catch (err) {
  console.error(r(`\nCould not reach Cloud Vision: ${err.message}`));
  console.error("\nIf you are behind a proxy or VPN, that is the first thing to check.\n");
  process.exit(1);
}
const ms = Date.now() - started;

console.log("1. the call itself");
ok(`HTTP ${res.status}`, res.ok, diagnose(res.status, body));
if (!res.ok) {
  console.error(`\n${r("The key does not work.")} ${diagnose(res.status, body)}\n`);
  process.exit(1);
}
ok(`answered in ${ms}ms`, ms < 15000, `${ms}ms is slower than expected`);

const first = body.responses?.[0];
if (first?.error) {
  console.error(`\n${r("Vision refused the image:")} ${diagnose(200, first)}\n`);
  process.exit(1);
}

console.log("\n2. what it read");
const words = flatten(first?.fullTextAnnotation ?? {});
const page = assemble(words);
ok(`found ${page.words} words`, page.words >= 25, "too few — is the fixture intact?");
ok(`mean confidence ${(page.confidence * 100).toFixed(1)}%`, page.confidence > 0.7);

const got = page.text.split("\n");
console.log(dim("\n--- transcription, indentation reconstructed ---"));
for (const line of got) console.log(dim("  " + line.replace(/ /g, "·")));
console.log(dim("--- (· marks a space, so indentation is visible) ---\n"));

console.log("3. is it the right text, laid out right");
ok(`${EXPECTED.length} lines`, got.length === EXPECTED.length, `got ${got.length}`);

const squash = (s) => s.replace(/\s+/g, "");
ok(
  "the characters match",
  squash(got.join("")) === squash(EXPECTED.join("")),
  "the words came back wrong — this is an OCR quality problem, not a key problem"
);

const indentOf = (s) => s.length - s.trimStart().length;
const wantIndent = EXPECTED.map(indentOf);
const gotIndent = got.map(indentOf);
ok(
  `indentation ${wantIndent.join(",")}`,
  JSON.stringify(wantIndent) === JSON.stringify(gotIndent),
  `got ${gotIndent.join(",")} — Python would not run`
);

if (page.unsure.length) {
  console.log("\n4. characters it was unsure of");
  for (const u of page.unsure) console.log(`  ${y("?")} ${u}`);
} else {
  console.log("\n4. it was sure of every word");
}

console.log(
  failed
    ? r(`\n${failed} check(s) failed — see above.\n`)
    : g("\nCloud Vision is working. The key reads code correctly, indentation included.\n")
);
process.exit(failed ? 1 : 0);
