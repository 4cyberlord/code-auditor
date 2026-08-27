#!/usr/bin/env node

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const workflow = process.env.CODE_AUDITOR_GITHUB_WORKFLOW || "cloud-benchmark.yml";

function usage() {
  console.log(`Usage:
  GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/github-actions-dispatch.mjs <job-id> <language> <artifact-key>

Environment:
  CODE_AUDITOR_GITHUB_WORKFLOW   Default: cloud-benchmark.yml
  CODE_AUDITOR_GITHUB_REF        Default: main`);
}

if (process.argv.includes("--help") || process.argv.length < 5) {
  usage();
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

if (!token || !repo) {
  console.error("GH_TOKEN/GITHUB_TOKEN and GITHUB_REPOSITORY are required.");
  process.exit(2);
}

const [jobId, language, artifactKey] = process.argv.slice(2);
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
        artifact_key: artifactKey,
      },
    }),
  }
);

if (!res.ok) {
  console.error(`${res.status} ${res.statusText}: ${await res.text()}`);
  process.exit(1);
}

console.log(`Dispatched ${workflow} for job ${jobId}.`);
