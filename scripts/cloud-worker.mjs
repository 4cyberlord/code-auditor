#!/usr/bin/env node
/**
 * Cloud solve worker scaffold.
 *
 * This process owns queued background jobs. It deliberately does not read local
 * Keychain secrets or screenshots: jobs arrive through Supabase rows and Storage,
 * while provider, GitHub/Codespaces and APNs secrets come from server-side env.
 */

import { createSign } from "node:crypto";

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const WORKER_ID = process.env.CODE_AUDITOR_WORKER_ID || `worker-${process.pid}`;
const POLL_MS = Number(process.env.CODE_AUDITOR_WORKER_POLL_MS || 5000);
const ONCE = process.argv.includes("--once");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return v;
}

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function nextQueuedJob() {
  const rows = await rest(
    "solve_jobs?status=eq.queued&order=created_at.asc&limit=1"
  );
  return rows?.[0] || null;
}

async function patchJob(id, patch) {
  const rows = await rest(`solve_jobs?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return rows?.[0] || null;
}

async function addEvent(jobId, level, phase, message, payload = {}) {
  await rest("solve_job_events", {
    method: "POST",
    body: JSON.stringify({
      job_id: jobId,
      level,
      phase,
      message,
      payload: { workerId: WORKER_ID, ...payload },
    }),
  });
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function apnsToken() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!keyId || !teamId || !privateKey) return null;

  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
  const signer = createSign("sha256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64url(sig)}`;
}

async function notify(jobId, title, body) {
  const bundleId = process.env.APNS_BUNDLE_ID;
  const token = apnsToken();
  if (!bundleId || !token) {
    await addEvent(jobId, "warn", "notify", "APNs credentials are missing; notification skipped.");
    return;
  }

  const devices = await rest("notification_devices?platform=eq.ios&enabled=eq.true");
  if (!devices?.length) {
    await addEvent(jobId, "info", "notify", "No enabled iOS notification devices are registered.");
    return;
  }

  const { connect } = await import("node:http2");
  const host =
    process.env.APNS_ENV === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
  const client = connect(host);
  try {
    for (const device of devices) {
      await new Promise((resolve) => {
        const req = client.request({
          ":method": "POST",
          ":path": `/3/device/${device.device_token}`,
          authorization: `bearer ${token}`,
          "apns-topic": bundleId,
          "apns-push-type": "alert",
        });
        let res = "";
        req.on("data", (chunk) => {
          res += chunk;
        });
        req.on("error", async (err) => {
          await addEvent(jobId, "warn", "notify", `APNs delivery failed: ${err.message}`);
          resolve();
        });
        req.on("end", async () => {
          if (res) {
            await addEvent(jobId, "warn", "notify", `APNs response: ${res}`);
          }
          resolve();
        });
        req.end(JSON.stringify({ aps: { alert: { title, body }, sound: "default" }, jobId }));
      });
    }
  } finally {
    client.close();
  }
}

async function claim(job) {
  const fresh = await rest(
    `solve_jobs?id=eq.${job.id}&status=eq.queued`,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "running",
        progress_phase: "claimed",
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      }),
    }
  );
  return fresh?.[0] || null;
}

async function runCouncilJob(job) {
  await addEvent(job.id, "info", "claimed", "Cloud worker claimed the job.");
  await notify(job.id, "Code Auditor", "Council job started.");

  if (!process.env.TOKENROUTER_API_KEY) {
    await addEvent(
      job.id,
      "error",
      "needs_attention",
      "TOKENROUTER_API_KEY is missing from the worker environment."
    );
    await patchJob(job.id, {
      status: "needs_attention",
      progress_phase: "needs_attention",
      error: "TOKENROUTER_API_KEY is missing from the worker environment.",
    });
    await notify(job.id, "Code Auditor", "Council job needs TokenRouter configuration.");
    return;
  }

  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    await addEvent(
      job.id,
      "warn",
      "benchmark_setup",
      "GitHub token is missing; Codespaces benchmark execution is not available yet."
    );
  }

  await addEvent(
    job.id,
    "warn",
    "executor_pending",
    "The persistent job queue is installed, but the cloud Council executor has not been wired to provider calls yet."
  );
  await patchJob(job.id, {
    status: "needs_attention",
    progress_phase: "executor_pending",
    error: "Cloud Council executor is not wired yet. Queue, events and history are ready.",
    result_summary: "Queued background job reached the worker; Council execution is the next implementation layer.",
  });
  await notify(job.id, "Code Auditor", "Council job reached the worker; executor wiring is next.");
}

async function tick() {
  const queued = await nextQueuedJob();
  if (!queued) return false;
  const job = await claim(queued);
  if (!job) return true;
  try {
    await runCouncilJob(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addEvent(job.id, "error", "failed", message).catch(() => {});
    await patchJob(job.id, {
      status: "failed",
      progress_phase: "failed",
      error: message,
      finished_at: new Date().toISOString(),
    }).catch(() => {});
  }
  return true;
}

console.log(`Code Auditor cloud worker ${WORKER_ID} polling ${SUPABASE_URL}`);
do {
  const worked = await tick();
  if (ONCE) break;
  if (!worked) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
} while (true);
