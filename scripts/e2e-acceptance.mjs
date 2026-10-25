#!/usr/bin/env node
/**
 * End-to-end acceptance: screenshot -> API -> worker -> E2B -> report.
 * Needs a signed-in helper token in COUNCIL_E2E_TOKEN; skips cleanly without it.
 *
 *   COUNCIL_E2E_TOKEN=... node scripts/e2e-acceptance.mjs
 */
import { readFileSync } from "node:fs";

const TOKEN = process.env.COUNCIL_E2E_TOKEN?.trim();
if (!TOKEN) {
  console.log("SKIP: COUNCIL_E2E_TOKEN is not set");
  process.exit(0);
}

const BASE = process.env.COUNCIL_API_URL?.trim() || "https://ikpzlesstdqauevsdwem.supabase.co/functions/v1/council-editor-api";
const KEY = process.env.COUNCIL_PUBLISHABLE_KEY?.trim() || "sb_publishable_qhH6xqP5MOdm2ITyHEXpxA_zbSuz2qf";
const headers = { apikey: KEY, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function call(op, args) {
  const response = await fetch(BASE, { method: "POST", headers, body: JSON.stringify({ op, args }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(`${op}: ${response.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.data;
}

const image = Buffer.from(readFileSync(new URL("../tests/fixtures/e2e-statement.b64", import.meta.url), "utf8").replace(/\s+/g, ""), "base64");
const settings = await call("settings.load", { key: "app.v1" });
const session = await call("sessions.create", { title: "e2e acceptance", mode: "coding" });
const owner = (await call("auth.whoami", {})).userId;
const path = `${owner}/${session.id}/e2e.png`;
const signed = (await call("storage.azureUploadUrl", { path })).url;
const upload = await fetch(signed, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "content-type": "image/png" }, body: image });
if (!upload.ok) throw new Error(`upload: ${upload.status}`);

const job = await call("jobs.create", {
  sessionId: session.id,
  submissionId: crypto.randomUUID(),
  mode: "council",
  settingsSnapshot: { ...settings, source: "overlay", overlayMode: "code" },
  images: [{ storageBucket: "azure:council-images", storagePath: path, fileName: "e2e.png", bytes: image.length, mime: "image/png", width: 900, height: 420 }],
});
console.log("job", job.id);

let status = "queued";
for (let attempt = 0; attempt < 96; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  status = (await call("jobs.get", { jobId: job.id })).status;
  if (["completed", "failed", "needs_attention"].includes(status)) break;
}
const report = status === "completed" ? await call("reports.get", { jobId: job.id }).catch(() => null) : null;
const final = report?.report ? JSON.parse(report.report) : null;
const answer = final?.final?.code || final?.final?.text || "";
console.log(`status=${status} answer_chars=${answer.length}`);
if (status !== "completed" || !answer.trim()) {
  const events = await call("jobs.events", { jobId: job.id }).catch(() => []);
  for (const event of events.slice(-6)) console.log(event.level, String(event.message).slice(0, 160));
  process.exit(1);
}
console.log("PASS: screenshot reached a verified answer through the full pipeline");
