#!/usr/bin/env node

import { Client } from "@upstash/qstash";

function usage() {
  console.log(`Usage:
  QSTASH_TOKEN=... CODE_AUDITOR_WORKER_TICK_URL=https://... node scripts/qstash-dispatch.mjs publish
  QSTASH_TOKEN=... CODE_AUDITOR_WORKER_TICK_URL=https://... node scripts/qstash-dispatch.mjs schedule
  QSTASH_TOKEN=... node scripts/qstash-dispatch.mjs schedules

Environment:
  CODE_AUDITOR_WORKER_TICK_URL   HTTPS endpoint QStash should call
  CODE_AUDITOR_QSTASH_CRON       Default: */5 * * * *
  CODE_AUDITOR_WORKER_TICK_SECRET Optional bearer token sent to your endpoint
  CODE_AUDITOR_QSTASH_RETRIES    Default: 3`);
}

function client() {
  if (!process.env.QSTASH_TOKEN && process.env.QSTASH_DEV !== "true") {
    console.error("QSTASH_TOKEN is required unless QSTASH_DEV=true.");
    process.exit(2);
  }
  return new Client({
    token: process.env.QSTASH_TOKEN,
    enableTelemetry: false,
    devMode: process.env.QSTASH_DEV === "true",
  });
}

function destination() {
  const url = process.env.CODE_AUDITOR_WORKER_TICK_URL;
  if (!url?.startsWith("https://") && process.env.QSTASH_DEV !== "true") {
    console.error("CODE_AUDITOR_WORKER_TICK_URL must be an HTTPS URL.");
    process.exit(2);
  }
  return url || "http://localhost:3000/api/worker-tick";
}

function headers() {
  const out = {
    "content-type": "application/json",
    "x-code-editor-source": "qstash",
  };
  const secret = process.env.CODE_AUDITOR_WORKER_TICK_SECRET || process.env.CODE_AUDITOR_QSTASH_SECRET;
  if (secret) {
    out.authorization = `Bearer ${secret}`;
  }
  return out;
}

async function publish() {
  const res = await client().publishJSON({
    url: destination(),
    retries: Number(process.env.CODE_AUDITOR_QSTASH_RETRIES || 3),
    headers: headers(),
    body: {
      source: "qstash",
      action: "worker_tick",
    },
  });
  console.log(`Published QStash message ${res.messageId}`);
}

async function schedule() {
  const res = await client().schedules.create({
    destination: destination(),
    cron: process.env.CODE_AUDITOR_QSTASH_CRON || "*/5 * * * *",
    retries: Number(process.env.CODE_AUDITOR_QSTASH_RETRIES || 3),
    headers: headers(),
    body: JSON.stringify({
      source: "qstash",
      action: "worker_tick",
    }),
  });
  console.log(`Created QStash schedule ${res.scheduleId}`);
}

async function schedules() {
  const rows = await client().schedules.list();
  for (const row of rows) {
    console.log(`${row.scheduleId}\t${row.destination}\t${row.cron || ""}`);
  }
}

const command = process.argv[2];
try {
  if (command === "publish") await publish();
  else if (command === "schedule") await schedule();
  else if (command === "schedules") await schedules();
  else {
    usage();
    process.exit(command ? 2 : 0);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
