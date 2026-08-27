/**
 * Benchmarking on GitHub Actions.
 *
 * E2B owns the fast generated-code gate. This file is the slower reproducible
 * evidence layer for candidates that already passed, using workflow_dispatch
 * and the same benchmark result format.
 *
 * The half that was missing is this file. `scripts/github-actions-dispatch.mjs`
 * could start a run and watch it finish, but never read the result back, so the
 * numbers the workflow carefully measured stayed in an artifact nobody opened.
 * This dispatches, waits, downloads the artifact and returns the measurement.
 *
 * On authentication: `gh auth token` is a *development* convenience and the
 * last thing tried, not the first. A packaged app has no GitHub CLI and no
 * login, so a token passed in explicitly always wins — which is what lets the
 * desktop app hand over a token it holds in the Keychain from its own device
 * flow, with no CLI anywhere in the picture.
 */

import { execFileSync } from "node:child_process";
import { extractText } from "./unzipOne.mjs";

const API = "https://api.github.com";

/**
 * Where a token can come from, most trustworthy first.
 *
 * Explicit beats ambient. A bundled app supplies `explicit` and sets
 * `allowCli: false`; a developer's shell supplies env vars; `gh` is the last
 * resort and is allowed to fail silently because on most machines running this
 * it simply is not installed.
 */
export function resolveTokens({ explicit = "", env = process.env, allowCli = true } = {}) {
  const tokens = [];
  if (explicit.trim()) tokens.push(explicit.trim());
  for (const name of ["CODE_AUDITOR_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    if (env[name]?.trim()) tokens.push(env[name].trim());
  }
  if (allowCli) {
    try {
      const clean = { ...env };
      delete clean.CODE_AUDITOR_GITHUB_TOKEN;
      delete clean.GH_TOKEN;
      delete clean.GITHUB_TOKEN;
      const cli = execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: clean,
      }).trim();
      if (cli) tokens.push(cli);
    } catch {
      // Not installed or not logged in. Both are normal outside development.
    }
  }
  return [...new Set(tokens)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(token, url, init = {}) {
  const res = await fetch(url.startsWith("http") ? url : `${API}${url}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  return res;
}

/** Turns GitHub's error bodies into something worth putting in a log. */
async function explain(res) {
  const text = await res.text().catch(() => "");
  if (res.status === 401) {
    return "GitHub rejected the token. It needs `repo` scope (or `actions:write` on a fine-grained token) to dispatch a workflow.";
  }
  if (res.status === 403) {
    return `GitHub refused: ${text.slice(0, 200)} — usually the token lacks Actions write, or the workflow is disabled on this repo.`;
  }
  if (res.status === 404) {
    return "Not found: check the repository name and that the workflow file exists on the target ref.";
  }
  if (res.status === 422) {
    return `GitHub could not accept the inputs: ${text.slice(0, 200)}`;
  }
  return `${res.status} ${res.statusText}: ${text.slice(0, 240)}`;
}

/**
 * Starts one benchmark run and returns the measurement.
 *
 * `correlationId` must be unique per candidate, not per job: the run is found
 * again by its display title, and dispatching two candidates of the same job in
 * the same language would otherwise produce two runs nobody can tell apart.
 */
export async function runGithubBenchmark({
  repo,
  token = "",
  allowCli = true,
  workflow = "cloud-benchmark.yml",
  ref = "main",
  correlationId,
  language,
  program,
  artifactKey = "",
  timeoutMs = 300_000,
  pollMs = 3000,
  log = () => {},
} = {}) {
  const started = Date.now();
  const fail = (note) => ({ ok: false, note, runtime: "github-actions", durationMs: Date.now() - started });

  if (!repo) return fail("No GITHUB_REPOSITORY configured for Actions benchmarking.");
  const tokens = resolveTokens({ explicit: token, allowCli });
  if (!tokens.length) return fail("No GitHub token available. Connect a GitHub account in Settings.");

  const title = `Benchmark ${correlationId} (${language})`;
  // A hair in the past: GitHub's created_at has second resolution, so an exact
  // "now" can exclude the very run we are about to start.
  const notBefore = new Date(Date.now() - 10_000).toISOString();
  const body = JSON.stringify({
    ref,
    inputs: {
      job_id: correlationId,
      language,
      program_b64: Buffer.from(program, "utf8").toString("base64"),
      artifact_key: artifactKey,
    },
  });

  let active = "";
  let lastErr = "";
  for (const candidate of tokens) {
    const res = await gh(candidate, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (res.ok || res.status === 204) {
      active = candidate;
      break;
    }
    lastErr = await explain(res);
    // Only credential problems are worth trying the next token for; a 422 is
    // the same bad input whoever sends it.
    if (res.status !== 401 && res.status !== 403) break;
  }
  if (!active) return fail(lastErr || "Dispatch was refused.");
  log(`dispatched ${workflow} for ${correlationId} (${language})`);

  // --- find the run, then wait for it
  let run = null;
  while (Date.now() - started < timeoutMs) {
    const res = await gh(
      active,
      `/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`
    );
    if (res.ok) {
      const { workflow_runs: runs = [] } = await res.json();
      const found = runs.find(
        (r) => r.display_title === title && new Date(r.created_at).toISOString() >= notBefore
      );
      if (found) {
        run = found;
        if (found.status === "completed") break;
      }
    }
    await sleep(pollMs);
  }
  if (!run) return fail("The workflow run never appeared — dispatch was accepted but nothing started.");
  if (run.status !== "completed") {
    return fail(`Timed out after ${Math.round((Date.now() - started) / 1000)}s waiting for the run.`);
  }
  log(`run ${run.id} ${run.conclusion} — ${run.html_url}`);

  // --- read the measurement out of the artifact
  const listed = await gh(active, `/repos/${repo}/actions/runs/${run.id}/artifacts`);
  if (!listed.ok) {
    return { ...fail(await explain(listed)), url: run.html_url, conclusion: run.conclusion };
  }
  const { artifacts = [] } = await listed.json();
  const art = artifacts.find((a) => a.name.startsWith("benchmark-result")) ?? artifacts[0];
  if (!art) {
    // A failed compile exits non-zero before the artifact step, so this is the
    // normal shape of "the candidate did not build" rather than an API problem.
    return {
      ok: false,
      note: run.conclusion === "success" ? "The run produced no benchmark artifact." : `Run ${run.conclusion}.`,
      runtime: "github-actions",
      durationMs: Date.now() - started,
      url: run.html_url,
      conclusion: run.conclusion,
    };
  }

  const zipRes = await gh(active, art.archive_download_url);
  if (!zipRes.ok) {
    return { ...fail(await explain(zipRes)), url: run.html_url, conclusion: run.conclusion };
  }
  const zip = Buffer.from(await zipRes.arrayBuffer());

  let parsed = null;
  let readErr = "";
  try {
    const text = extractText(zip, ".json");
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    readErr = err instanceof Error ? err.message : String(err);
  }
  if (!parsed) {
    return {
      ...fail(readErr || "The artifact held no readable benchmark JSON."),
      url: run.html_url,
      conclusion: run.conclusion,
    };
  }

  return {
    ok: run.conclusion === "success" && parsed.ok !== false,
    runtime: parsed.runtime || "github-actions",
    /** Wall clock for the whole dispatch, including queue time. */
    durationMs: Date.now() - started,
    /** What the program itself took, as measured on the runner. */
    remoteElapsedMs: parsed.elapsedMs ?? parsed.durationMs ?? null,
    peakMemoryKb: parsed.peakMemoryKb ?? null,
    passed: parsed.passed ?? null,
    failed: parsed.failed ?? null,
    exitCode: parsed.exitCode ?? null,
    note: parsed.note || (run.conclusion === "success" ? "" : `Run ${run.conclusion}.`),
    url: run.html_url,
    conclusion: run.conclusion,
    raw: parsed,
  };
}
