#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv(path.join(process.cwd(), ".development.env"));

const repo = process.env.GITHUB_REPOSITORY;
const workflow = process.env.CODE_AUDITOR_GITHUB_WORKFLOW || "cloud-benchmark.yml";
const WAIT = process.argv.includes("--wait");

function usage() {
  console.log(`Usage:
  GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/github-actions-dispatch.mjs <job-id> <language> <program-file> [artifact-key] [--wait]

Environment:
  CODE_AUDITOR_GITHUB_WORKFLOW   Default: cloud-benchmark.yml
  CODE_AUDITOR_GITHUB_REF        Default: main`);
}

if (process.argv.includes("--help") || process.argv.length < 5) {
  usage();
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

function tokenCandidates() {
  const tokens = [];
  tokens.push(
    ...[
      process.env.CODE_AUDITOR_GITHUB_TOKEN,
      process.env.GH_TOKEN,
      process.env.GITHUB_TOKEN,
    ].filter(Boolean)
  );
  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.GH_TOKEN;
    delete cleanEnv.GITHUB_TOKEN;
    delete cleanEnv.CODE_AUDITOR_GITHUB_TOKEN;
    const cli = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: cleanEnv,
    }).trim();
    if (cli) tokens.push(cli);
  } catch {
    // gh is optional; explicit env tokens are enough in CI.
  }
  return [...new Set(tokens)];
}

const tokens = tokenCandidates();
let activeToken = tokens[0] || "";

if (!tokens.length || !repo) {
  console.error("CODE_AUDITOR_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN or a logged-in GitHub CLI, plus GITHUB_REPOSITORY, are required.");
  process.exit(2);
}

const positional = process.argv.slice(2).filter((arg) => arg !== "--wait");
const [jobId, language, programFile, artifactKey = ""] = positional;
const program = readFileSync(path.resolve(process.cwd(), programFile), "utf8");
const programB64 = Buffer.from(program, "utf8").toString("base64");
const dispatchedAfter = new Date(Date.now() - 5000).toISOString();

async function github(pathname, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}/${pathname}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${activeToken}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function dispatchWith(token) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: process.env.CODE_AUDITOR_GITHUB_REF || "main",
        inputs: {
          job_id: jobId,
          language,
          program_b64: programB64,
          artifact_key: artifactKey,
        },
      }),
    }
  );
  return { res, text: await res.text() };
}

let last = null;
for (const token of tokens) {
  activeToken = token;
  last = await dispatchWith(token);
  if (last.res.ok) break;
  if (last.res.status !== 403 && last.res.status !== 401) break;
}

if (!last?.res.ok) {
  console.error(`${last?.res.status} ${last?.res.statusText}: ${last?.text}`);
  process.exit(1);
}

console.log(`Dispatched ${workflow} for job ${jobId}.`);

if (WAIT) {
  const title = `Benchmark ${jobId} (${language})`;
  let run = null;
  for (let i = 0; i < 60; i++) {
    const runs = await github(`actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`);
    run = runs.workflow_runs?.find(
      (candidate) =>
        candidate.display_title === title &&
        new Date(candidate.created_at).toISOString() >= dispatchedAfter
    );
    if (run?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!run) {
    console.log("Dispatch accepted, but the run did not appear before the wait timeout.");
  } else {
    console.log(`Run ${run.id}: ${run.status}/${run.conclusion || "pending"} ${run.html_url}`);
    process.exit(run.conclusion === "success" ? 0 : 1);
  }
}
