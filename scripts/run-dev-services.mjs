#!/usr/bin/env node
/**
 * Development-only companion processes for the native app.
 *
 * The desktop UI queues E2B work in Supabase, so a dev app without a worker
 * looks healthy until verification begins. Keep the frontend and isolated
 * worker pool alive together, while reusing an already-running port 3000 when
 * a developer started Next separately.
 */
import net from "node:net";
import { spawn } from "node:child_process";

const port = 3000;
const isListening = () => new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

const children = [];
if (!await isListening()) {
  children.push(spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port)], {
    stdio: "inherit",
  }));
} else {
  console.log(`Reusing frontend already listening on :${port}`);
}
children.push(spawn(process.execPath, ["scripts/run-worker-pool.mjs"], {
  stdio: "inherit",
  env: { ...process.env, CODE_AUDITOR_WORKER_COUNT: process.env.CODE_AUDITOR_WORKER_COUNT || "2" },
}));

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const exits = children.map(child => new Promise(resolve => child.once("exit", resolve)));
await Promise.race(exits);
stop("SIGTERM");
process.exitCode = stopping ? 0 : 1;
