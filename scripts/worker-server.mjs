#!/usr/bin/env node

import { createServer } from "node:http";
import { tick } from "./cloud-worker.mjs";
import { captureWorkerException, closeObservability, notifyOps } from "./observability.mjs";

const PORT = Number(process.env.PORT || process.env.CODE_AUDITOR_WORKER_PORT || 8787);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

function bearer(req) {
  const auth = req.headers.authorization || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function allowed(req, envName) {
  const expected = process.env[envName];
  return !expected || bearer(req) === expected;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function rest(path, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function registerDevice(req, res) {
  if (!allowed(req, "CODE_AUDITOR_DEVICE_REGISTRATION_SECRET")) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const body = await readJson(req);
  const token = String(body.deviceToken || body.device_token || "").trim();
  if (!/^[a-fA-F0-9]{32,}$/.test(token)) {
    json(res, 400, { ok: false, error: "invalid device token" });
    return;
  }
  const label = String(body.label || "iPhone").slice(0, 80);
  const rows = await rest("notification_devices?on_conflict=device_token", {
    method: "POST",
    body: JSON.stringify({
      platform: "ios",
      device_token: token,
      label,
      enabled: true,
    }),
  });
  json(res, 200, { ok: true, device: rows?.[0] || null });
}

async function workerTick(req, res) {
  if (!allowed(req, "CODE_AUDITOR_WORKER_TICK_SECRET")) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const started = Date.now();
  const worked = await tick();
  json(res, 200, {
    ok: true,
    worked,
    durationMs: Date.now() - started,
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, service: "code-editor-worker" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/worker-tick") {
      await workerTick(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/register-device") {
      await registerDevice(req, res);
      return;
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureWorkerException(err, { phase: "worker_server" });
    await notifyOps({
      level: "error",
      title: "Worker endpoint failed",
      body: message,
      phase: "worker_server",
    }).catch(() => {});
    json(res, 500, { ok: false, error: message });
  }
});

server.listen(PORT, () => {
  console.log(`Code Editor worker server listening on :${PORT}`);
});

process.on("SIGTERM", async () => {
  server.close();
  await closeObservability();
  process.exit(0);
});
