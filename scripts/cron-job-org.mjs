#!/usr/bin/env node

// Configuration lives in the database now. Imports are evaluated before this
// module's body, so app_config is in process.env by the time `apiKey` is read.
import "./lib/config.mjs";

const API = "https://api.cron-job.org";
const apiKey = process.env.CRON_JOB_ORG_API_KEY;

function usage() {
  console.log(`Usage:
  CRON_JOB_ORG_API_KEY=... CODE_AUDITOR_WORKER_TICK_URL=https://... node scripts/cron-job-org.mjs upsert
  CRON_JOB_ORG_API_KEY=... node scripts/cron-job-org.mjs list

Environment:
  CODE_AUDITOR_WORKER_TICK_URL   HTTPS endpoint cron-job.org should call
  CODE_AUDITOR_CRON_TITLE        Default: Council Editor cloud worker tick
  CODE_AUDITOR_CRON_MINUTES      Default: 5
  CODE_AUDITOR_CRON_TIMEZONE     Default: UTC
  CODE_AUDITOR_WORKER_TICK_SECRET Optional bearer token sent to your worker endpoint`);
}

function requireApiKey() {
  if (!apiKey) {
    console.error("CRON_JOB_ORG_API_KEY is required.");
    process.exit(2);
  }
}

function minuteSchedule(every) {
  const n = Math.max(1, Math.min(60, Number(every || 5)));
  if (n === 1) return [-1];
  const minutes = [];
  for (let m = 0; m < 60; m += n) minutes.push(m);
  return minutes;
}

async function cron(path, init = {}) {
  requireApiKey();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function workerJob() {
  const url = process.env.CODE_AUDITOR_WORKER_TICK_URL;
  if (!url?.startsWith("https://")) {
    console.error("CODE_AUDITOR_WORKER_TICK_URL must be an HTTPS URL.");
    process.exit(2);
  }
  const headers = {
    "content-type": "application/json",
    "x-council-editor-source": "cron-job.org",
  };
  const secret = process.env.CODE_AUDITOR_WORKER_TICK_SECRET || process.env.CODE_AUDITOR_CRON_SECRET;
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
  }
  return {
    title: process.env.CODE_AUDITOR_CRON_TITLE || "Council Editor cloud worker tick",
    enabled: true,
    saveResponses: true,
    url,
    requestMethod: 1,
    requestTimeout: 60,
    redirectSuccess: false,
    schedule: {
      timezone: process.env.CODE_AUDITOR_CRON_TIMEZONE || "UTC",
      expiresAt: 0,
      hours: [-1],
      mdays: [-1],
      minutes: minuteSchedule(process.env.CODE_AUDITOR_CRON_MINUTES),
      months: [-1],
      wdays: [-1],
    },
    extendedData: {
      headers,
      body: JSON.stringify({ source: "cron-job.org", action: "worker_tick" }),
    },
  };
}

async function list() {
  const { jobs = [] } = await cron("/jobs");
  for (const job of jobs) {
    console.log(
      `${job.jobId}\t${job.enabled ? "enabled" : "disabled"}\t${job.title || "(untitled)"}\t${job.url}`
    );
  }
}

async function upsert() {
  const desired = workerJob();
  const { jobs = [] } = await cron("/jobs");
  const existing = jobs.find((job) => job.title === desired.title);
  if (existing) {
    await cron(`/jobs/${existing.jobId}`, {
      method: "PATCH",
      body: JSON.stringify({ job: desired }),
    });
    console.log(`Updated cron-job.org job ${existing.jobId}: ${desired.title}`);
    return;
  }
  const created = await cron("/jobs", {
    method: "PUT",
    body: JSON.stringify({ job: desired }),
  });
  console.log(`Created cron-job.org job ${created.jobId}: ${desired.title}`);
}

const command = process.argv[2];
try {
  if (command === "list") await list();
  else if (command === "upsert") await upsert();
  else {
    usage();
    process.exit(command ? 2 : 0);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
