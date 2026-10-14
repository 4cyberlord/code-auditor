#!/usr/bin/env node
/**
 * Starts a small pool of isolated workers. Each process has its own per-job
 * secret scope; the database's conditional claim remains the single source of
 * truth, so two workers cannot process the same queued row.
 */
import { spawn } from "node:child_process";

const requested = Number(process.env.CODE_AUDITOR_WORKER_COUNT || 2);
const count = Number.isSafeInteger(requested) ? Math.max(1, Math.min(requested, 4)) : 2;
const children = [];
let stopping = false;

for (let index = 0; index < count; index += 1) {
  const child = spawn(process.execPath, ["scripts/cloud-worker.mjs"], {
    stdio: "inherit",
    env: { ...process.env, CODE_AUDITOR_WORKER_ID: `pool-${process.pid}-${index + 1}` },
  });
  children.push(child);
}

const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const exits = children.map(child => new Promise(resolve => child.once("exit", resolve)));
await Promise.all(exits);
process.exitCode = stopping ? 0 : 1;
