#!/usr/bin/env node
/**
 * Cloud solve worker.
 *
 * This process owns queued background jobs. It deliberately does not read local
 * Keychain secrets or screenshots: jobs arrive through Supabase rows and Storage,
 * while provider, GitHub/Codespaces and APNs secrets come from server-side env.
 *
 * v1 runs a compact Council: independent solver calls, benchmark generation and
 * execution, reviewer passes, judge passes and one synthesis pass. Revision
 * rounds are intentionally recorded as missing evidence until that server-side
 * layer is added.
 */

import { createSign } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  captureWorkerException,
  closeObservability,
  initObservability,
  notifyOps,
  recordWorkerEvent,
} from "./observability.mjs";

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const TOKENROUTER_API_KEY = process.env.TOKENROUTER_API_KEY || "";
const WORKER_ID = process.env.CODE_AUDITOR_WORKER_ID || `worker-${process.pid}`;
const POLL_MS = Number(process.env.CODE_AUDITOR_WORKER_POLL_MS || 5000);
const ONCE = process.argv.includes("--once");
const STORAGE_BUCKET = "screenshots";
const APP_DISPLAY_NAME = "Code Editor";
const SLOW_JOB_MS = Number(process.env.CODE_AUDITOR_SLOW_JOB_MS || 180_000);

initObservability({ service: "cloud-worker", workerId: WORKER_ID });

const [{ systemPrompt, userPrompt }, { parseFinal }, council] = await Promise.all([
  import("../src/lib/prompts.ts"),
  import("../src/lib/parse.ts"),
  import("../src/lib/council.ts"),
]);

const {
  COUNCIL_DEFAULT_MODELS,
  COUNCIL_DEFAULT_JUDGES,
  candidateDocket,
  candidateLanguage,
  countCases,
  councilMarkdown,
  executionDigest,
  judgeSystemPrompt,
  judgeUserPrompt,
  letterFor,
  parseTestSuites,
  parseReviewSet,
  reviewSystemPrompt,
  reviewUserPrompt,
  spliceSuite,
  synthesisSystemPrompt,
  synthesisUserPrompt,
  testSpecSystemPrompt,
  testSpecUserPrompt,
} = council;

const MAX_OUTPUT = 64 * 1024;
const LOCAL_RUN_TIMEOUT_MS = 20_000;
const REMOTE_RUN_TIMEOUT_MS = 120_000;

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

async function storage(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
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
  recordWorkerEvent(jobId, level, phase, message, payload);
}

async function listJobImages(jobId) {
  return await rest(`solve_job_images?job_id=eq.${jobId}&order=position.asc`);
}

async function signedStorageUrl(path, seconds = 900) {
  const signed = await storage(`object/sign/${STORAGE_BUCKET}/${path}`, {
    method: "POST",
    body: JSON.stringify({ expiresIn: seconds }),
  });
  const value = signed?.signedURL || signed?.signedUrl;
  if (!value) throw new Error(`Supabase Storage returned no signed URL for ${path}`);
  return value.startsWith("http")
    ? value
    : `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1${value}`;
}

async function downloadJobImages(jobId) {
  const rows = await listJobImages(jobId);
  const out = [];
  for (const row of rows || []) {
    const url = await signedStorageUrl(row.storage_path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${row.file_name}: ${res.status} ${res.statusText}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    out.push({
      position: row.position,
      fileName: row.file_name,
      mime: row.mime || "image/png",
      dataUrl: `data:${row.mime || "image/png"};base64,${bytes.toString("base64")}`,
    });
  }
  return out;
}

function chatModels(settings) {
  const configured = Array.isArray(settings?.councilModels)
    ? settings.councilModels
    : COUNCIL_DEFAULT_MODELS;
  return configured
    .filter((model) => model?.id && model.endpoint !== "responses")
    .slice(0, Number(process.env.CODE_AUDITOR_WORKER_SOLVERS || 4));
}

function chatJudges(settings) {
  const configured = Array.isArray(settings?.councilJudges)
    ? settings.councilJudges
    : COUNCIL_DEFAULT_JUDGES;
  return configured
    .filter((judge) => judge?.model)
    .filter((judge) => !COUNCIL_DEFAULT_MODELS.find((model) => model.id === judge.model && model.endpoint === "responses"))
    .slice(0, Number(process.env.CODE_AUDITOR_WORKER_JUDGES || 3));
}

function gatewayBaseUrl(settings) {
  return settings?.gatewayBaseUrl || "https://api.tokenrouter.com/v1";
}

async function tokenRouterChat({ baseUrl, model, system, user, images = [], maxTokens = 4096 }) {
  const content = [{ type: "text", text: user }];
  for (const image of images) {
    content.push({ type: "image_url", image_url: { url: image.dataUrl } });
  }

  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKENROUTER_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${model}: ${resp.status} ${resp.statusText}: ${text}`);
  const json = JSON.parse(text);
  const answer = json?.choices?.[0]?.message?.content;
  if (!answer?.trim()) throw new Error(`${model}: empty model response`);
  return answer;
}

function winnerFromSynthesis(text) {
  const m = text.match(/^\s*WINNER\s*:\s*([A-Z]|NONE)\b/im);
  return m && m[1] !== "NONE" ? m[1] : "";
}

function reviewDigest(reviews) {
  return reviews
    .map((set) => `${set.reviewer}\n${set.raw || "(no structured review block)"}`)
    .join("\n\n---\n\n");
}

function judgeDigest(judges) {
  return judges
    .map((judge) =>
      `${judge.model} (${judge.emphasis})\n${judge.error ? `ERROR: ${judge.error}` : judge.text}`
    )
    .join("\n\n---\n\n");
}

function clampOutput(raw) {
  if (raw.length <= MAX_OUTPUT) return { text: raw, truncated: false };
  const head = Math.floor((MAX_OUTPUT * 2) / 3);
  const tail = MAX_OUTPUT - head;
  return {
    text: `${raw.slice(0, head)}\n\n... ${raw.length - MAX_OUTPUT} bytes dropped ...\n\n${raw.slice(-tail)}`,
    truncated: true,
  };
}

function isCommonJs(code) {
  const stripped = code
    .split("\n")
    .map((line) => line.split("//")[0] || "")
    .join("\n");
  if (/\bimport\s|\bexport\s|import\(/.test(stripped)) return false;
  return /require\(|module\.exports|exports\.|__dirname|__filename/.test(stripped);
}

function runtimeFor(language, code) {
  const lang = String(language || "").trim().toLowerCase().replace(/^\./, "");
  if (["python", "python3", "py", "py3"].includes(lang)) return { file: "main.py", command: "python3 main.py", runtime: "python3" };
  if (["javascript", "js", "node", "nodejs", "mjs", "cjs"].includes(lang)) {
    if (isCommonJs(code)) return { file: "main.cjs", command: "node main.cjs", runtime: "node (commonjs)" };
    return { file: "main.mjs", command: "node main.mjs", runtime: "node (esm)" };
  }
  if (["typescript", "ts"].includes(lang)) return { file: "main.ts", command: "node --experimental-strip-types main.ts", runtime: "node (type stripping)" };
  if (["bash", "sh", "shell", "zsh", "console"].includes(lang)) return { file: "main.sh", command: "bash main.sh", runtime: "bash" };
  if (["ruby", "rb"].includes(lang)) return { file: "main.rb", command: "ruby main.rb", runtime: "ruby" };
  if (lang === "php") return { file: "main.php", command: "php main.php", runtime: "php" };
  if (lang === "c") return { file: "main.c", command: "cc -std=c17 -O1 main.c -o prog -lm && ./prog", runtime: "cc" };
  if (["cpp", "c++", "cc", "cxx"].includes(lang)) return { file: "main.cpp", command: "c++ -std=c++20 -O1 main.cpp -o prog && ./prog", runtime: "c++" };
  if (lang === "java") return { file: "Main.java", command: "java Main.java", runtime: "java" };
  if (["go", "golang"].includes(lang)) return { file: "main.go", command: "go run main.go", runtime: "go" };
  if (["rust", "rs"].includes(lang)) return { file: "main.rs", command: "rustc -O main.rs -o prog 2>&1 && ./prog", runtime: "rustc" };
  return null;
}

async function runLocalCode(language, code, timeoutMs = LOCAL_RUN_TIMEOUT_MS) {
  const runtime = runtimeFor(language, code);
  if (!runtime) throw new Error(`Unsupported benchmark language: ${language || "unknown"}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-auditor-worker-"));
  const started = Date.now();
  let timedOut = false;
  try {
    await fs.writeFile(path.join(dir, runtime.file), code, "utf8");
    const child = spawn("bash", ["-lc", runtime.command], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, Math.max(1000, Math.min(timeoutMs, 60_000)));
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    }).finally(() => clearTimeout(timer));
    const out = clampOutput(stdout);
    const err = clampOutput(stderr);
    return {
      ok: exitCode === 0 && !timedOut,
      runtime: runtime.runtime,
      exitCode,
      stdout: out.text,
      stderr: err.text,
      durationMs: Date.now() - started,
      timedOut,
      truncated: out.truncated || err.truncated,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function shellSingle(s) {
  return `'${String(s).replaceAll("'", `'"'"'`)}'`;
}

function remoteScript(language, code) {
  const encoded = Buffer.from(code, "utf8").toString("base64");
  return `set -u
tmp="$(mktemp -d "\${TMPDIR:-/tmp}/code-auditor-bench.XXXXXX")" || exit 98
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
cd "$tmp" || exit 98
cat > code.b64 <<'CA_CODE'
${encoded}
CA_CODE
base64 -d code.b64 > code.txt
lang=${shellSingle(language)}
case "$(printf '%s' "$lang" | tr '[:upper:]' '[:lower:]')" in
  python|python3|py|py3) file=main.py; cp code.txt "$file"; command='python3 main.py'; runtime='codespace python3' ;;
  javascript|js|node|nodejs|mjs) file=main.mjs; cp code.txt "$file"; command='node main.mjs'; runtime='codespace node esm' ;;
  cjs) file=main.cjs; cp code.txt "$file"; command='node main.cjs'; runtime='codespace node commonjs' ;;
  typescript|ts) file=main.ts; cp code.txt "$file"; command='node --experimental-strip-types main.ts'; runtime='codespace node type stripping' ;;
  bash|sh|shell) file=main.sh; cp code.txt "$file"; command='bash main.sh'; runtime='codespace bash' ;;
  ruby|rb) file=main.rb; cp code.txt "$file"; command='ruby main.rb'; runtime='codespace ruby' ;;
  php) file=main.php; cp code.txt "$file"; command='php main.php'; runtime='codespace php' ;;
  c) file=main.c; cp code.txt "$file"; command='cc -std=c17 -O2 main.c -o prog -lm && ./prog'; runtime='codespace cc -O2' ;;
  cpp|c++|cc|cxx) file=main.cpp; cp code.txt "$file"; command='c++ -std=c++20 -O2 main.cpp -o prog && ./prog'; runtime='codespace c++ -O2' ;;
  java) file=Main.java; cp code.txt "$file"; command='java Main.java'; runtime='codespace java' ;;
  go|golang) file=main.go; cp code.txt "$file"; command='go run main.go'; runtime='codespace go' ;;
  rust|rs) file=main.rs; cp code.txt "$file"; command='rustc -O main.rs -o prog 2>&1 && ./prog'; runtime='codespace rustc -O' ;;
  *) echo "Unsupported remote benchmark language: $lang" >&2; exit 97 ;;
esac
status=0
if command -v /usr/bin/time >/dev/null 2>&1; then
  /usr/bin/time -f 'CA_METRICS elapsed_s=%e maxrss_kb=%M' bash -lc "$command" >stdout.txt 2>stderr.txt || status=$?
else
  start="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  bash -lc "$command" >stdout.txt 2>stderr.txt || status=$?
  finish="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  printf 'CA_METRICS elapsed_ms=%s maxrss_kb=\\n' "$((finish - start))" >>stderr.txt
fi
printf 'CA_STDOUT_BEGIN\\n'
cat stdout.txt 2>/dev/null || true
printf '\\nCA_STDOUT_END\\nCA_STDERR_BEGIN\\n'
cat stderr.txt 2>/dev/null || true
printf '\\nCA_STDERR_END\\nCA_EXIT:%s\\nCA_RUNTIME:%s\\n' "$status" "$runtime"
exit "$status"
`;
}

function parseRemoteOutput(raw) {
  const between = (start, end) => {
    const from = raw.indexOf(start);
    if (from < 0) return "";
    const begin = from + start.length;
    const to = raw.indexOf(end, begin);
    return to < 0 ? "" : raw.slice(begin, to);
  };
  const stderr = between("CA_STDERR_BEGIN\n", "\nCA_STDERR_END");
  const metrics = {};
  for (const line of stderr.split("\n")) {
    if (!line.startsWith("CA_METRICS ")) continue;
    for (const part of line.slice("CA_METRICS ".length).split(/\s+/)) {
      const [key, value] = part.split("=");
      if (key) metrics[key] = value;
    }
  }
  const exit = raw.match(/^CA_EXIT:(-?\d+)/m);
  const runtime = raw.match(/^CA_RUNTIME:(.+)$/m);
  return {
    stdout: between("CA_STDOUT_BEGIN\n", "\nCA_STDOUT_END"),
    stderr,
    exitCode: exit ? Number(exit[1]) : null,
    runtime: runtime?.[1]?.trim() || "codespace",
    remoteElapsedMs: metrics.elapsed_s ? Math.round(Number(metrics.elapsed_s) * 1000) : metrics.elapsed_ms ? Number(metrics.elapsed_ms) : null,
    peakMemoryKb: metrics.maxrss_kb ? Number(metrics.maxrss_kb) : null,
  };
}

async function runRemoteCode(codespace, language, code, timeoutMs = REMOTE_RUN_TIMEOUT_MS) {
  const started = Date.now();
  let timedOut = false;
  const child = spawn("gh", ["codespace", "ssh", "-c", codespace, "--", "bash", "-s"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(remoteScript(language, code));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, Math.max(1000, Math.min(timeoutMs, REMOTE_RUN_TIMEOUT_MS)));
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  }).finally(() => clearTimeout(timer));
  const parsed = parseRemoteOutput(stdout);
  const out = clampOutput(parsed.stdout);
  const err = clampOutput([parsed.stderr, stderr].filter((s) => s?.trim()).join("\n"));
  const effectiveExit = parsed.exitCode ?? exitCode;
  return {
    ok: effectiveExit === 0 && !timedOut,
    runtime: parsed.runtime,
    exitCode: effectiveExit,
    stdout: out.text,
    stderr: err.text,
    durationMs: Date.now() - started,
    remoteElapsedMs: parsed.remoteElapsedMs,
    peakMemoryKb: parsed.peakMemoryKb,
    timedOut,
    truncated: out.truncated || err.truncated,
    codespace,
  };
}

async function runE2BCode(language, code, timeoutMs = REMOTE_RUN_TIMEOUT_MS) {
  const started = Date.now();
  const { Sandbox } = await import("@e2b/code-interpreter");
  const sandbox = await Sandbox.create({
    timeoutMs: Math.max(timeoutMs + 30_000, 90_000),
    metadata: {
      app: "code-editor",
      workerId: WORKER_ID,
      purpose: "benchmark",
    },
  });
  try {
    const result = await sandbox.commands.run(`bash -lc ${shellSingle(remoteScript(language, code))}`, {
      timeoutMs,
    });
    const parsed = parseRemoteOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
    const out = clampOutput(parsed.stdout || result.stdout || "");
    const err = clampOutput(parsed.stderr || result.stderr || "");
    const exitCode = parsed.exitCode ?? result.exitCode ?? 0;
    return {
      ok: exitCode === 0,
      runtime: parsed.runtime || "e2b",
      exitCode,
      stdout: out.text,
      stderr: err.text,
      durationMs: Date.now() - started,
      remoteElapsedMs: parsed.remoteElapsedMs,
      peakMemoryKb: parsed.peakMemoryKb,
      timedOut: false,
      truncated: out.truncated || err.truncated,
      provider: "e2b",
      sandboxId: sandbox.sandboxId,
    };
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

function executionProvider(settings) {
  return String(
    settings.executionProvider ||
      process.env.CODE_AUDITOR_EXECUTION_PROVIDER ||
      "local"
  )
    .trim()
    .toLowerCase();
}

async function runVerification(settings, suite, program) {
  const provider = executionProvider(settings);
  if (provider === "e2b") {
    if (!process.env.E2B_API_KEY) {
      throw new Error("E2B_API_KEY is missing, so E2B benchmark execution cannot run.");
    }
    return runE2BCode(suite.language, program, Number(settings.e2bTimeoutMs || REMOTE_RUN_TIMEOUT_MS));
  }
  return runLocalCode(suite.language, program, LOCAL_RUN_TIMEOUT_MS);
}

async function benchmarkCandidates(job, settings, baseUrl, models, judges, question, candidates) {
  const codeCandidates = candidates.filter((c) => c.final?.kind === "code" && c.final.code?.trim());
  if (codeCandidates.length < 2) {
    await addEvent(
      job.id,
      "info",
      "benchmark_skipped",
      "Fewer than two runnable code candidates; MCQ, math, research and plain-answer jobs use Council reasoning validation instead of code execution."
    );
    return { suites: [], runs: {} };
  }

  await patchJob(job.id, { progress_phase: "speccing" });
  await addEvent(job.id, "info", "speccing", "Generating language-specific benchmark harnesses.");
  const languages = Array.from(new Set(codeCandidates.map((c) => candidateLanguage(c.final)).filter(Boolean)));
  const specModel = settings.synthesisModel || judges[0]?.model || models[0]?.id;
  let suites = [];
  try {
    const specText = await tokenRouterChat({
      baseUrl,
      model: specModel,
      system: testSpecSystemPrompt(),
      user: testSpecUserPrompt({
        question,
        docket: candidateDocket(candidates),
        languages,
        knowledge: settings.knowledgeDigest || "",
      }),
      maxTokens: Number(settings.maxTokens || 4096),
    });
    suites = parseTestSuites(specText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addEvent(job.id, "warn", "spec_failed", `Benchmark spec generation failed: ${message}`);
    return { suites: [], runs: {} };
  }

  if (!suites.length) {
    await addEvent(job.id, "warn", "benchmark_skipped", "The benchmark spec did not contain any runnable harnesses.");
    return { suites, runs: {} };
  }

  await patchJob(job.id, { progress_phase: "verifying" });
  await addEvent(job.id, "info", "verifying", `Running ${codeCandidates.length} candidates through generated benchmarks.`);
  const runs = {};
  for (const candidate of candidates) {
    const lang = candidate.final?.kind === "code" ? candidateLanguage(candidate.final) : "";
    const suite = suites.find((s) => s.language === lang);
    const code = candidate.final?.code || "";
    if (!candidate.final || candidate.final.kind !== "code" || !code.trim()) {
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: candidate.final?.kind === "research" ? "research answer" : "no code", runtime: "" };
      continue;
    }
    if (!suite) {
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: `no suite for ${lang || "unknown language"}`, runtime: "" };
      continue;
    }
    const program = spliceSuite(suite, code);
    if (!program) {
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: "harness has no splice marker", runtime: "" };
      continue;
    }
    try {
      const local = await runVerification(settings, suite, program);
      const localCases = countCases(local.stdout);
      let remote;
      const codespace = settings.codespacesBenchmark
        ? String(settings.codespacesName || process.env.CODE_AUDITOR_CODESPACE_NAME || "").trim()
        : "";
      if (codespace && local.ok && localCases.failed === 0 && localCases.passed > 0) {
        try {
          const rb = await runRemoteCode(codespace, suite.language, program, Number(settings.codespacesTimeoutMs || 30_000));
          const remoteCases = countCases(rb.stdout);
          remote = {
            ok: rb.ok && remoteCases.failed === 0 && remoteCases.passed > 0,
            codespace: rb.codespace,
            runtime: rb.runtime,
            durationMs: rb.durationMs,
            remoteElapsedMs: rb.remoteElapsedMs,
            peakMemoryKb: rb.peakMemoryKb,
            note: rb.timedOut
              ? "timed out"
              : rb.exitCode !== 0
                ? `exit ${rb.exitCode}`
                : remoteCases.passed > 0
                  ? `${remoteCases.passed} remote case(s) passed`
                  : "no PASS lines",
          };
        } catch (err) {
          remote = {
            ok: false,
            codespace,
            runtime: "codespace",
            durationMs: 0,
            remoteElapsedMs: null,
            peakMemoryKb: null,
            note: err instanceof Error ? err.message : String(err),
          };
        }
      }
      runs[candidate.letter] = {
        letter: candidate.letter,
        ran: true,
        ok: local.ok,
        passed: localCases.passed,
        failed: localCases.failed,
        durationMs: local.durationMs,
        note: local.timedOut ? "timed out" : local.exitCode !== 0 ? `exit ${local.exitCode}` : "",
        runtime: local.runtime,
        remote,
      };
      await addEvent(job.id, local.ok && localCases.failed === 0 ? "info" : "warn", "benchmark_done", `Candidate ${candidate.letter}: ${runs[candidate.letter].note || `${localCases.passed} case(s) passed`}.`, runs[candidate.letter]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: message, runtime: "" };
      await addEvent(job.id, "warn", "benchmark_failed", `Candidate ${candidate.letter} benchmark failed: ${message}`, runs[candidate.letter]);
    }
  }

  return { suites, runs };
}

async function saveCouncilReport(job, report) {
  const markdown = councilMarkdown(report);
  await rest("council_reports", {
    method: "POST",
    body: JSON.stringify({
      job_id: job.id,
      session_id: job.session_id,
      winner: report.winner || null,
      synthesis: report.synthesis,
      markdown,
      report,
    }),
  });
  return markdown;
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

export async function runCouncilJob(job) {
  await addEvent(job.id, "info", "claimed", "Cloud worker claimed the job.");
  await notify(job.id, APP_DISPLAY_NAME, "Council job started.");

  if (!TOKENROUTER_API_KEY) {
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
      finished_at: new Date().toISOString(),
    });
    await notify(job.id, APP_DISPLAY_NAME, "Council job needs TokenRouter configuration.");
    await notifyOps({
      level: "warn",
      title: "Council job needs attention",
      body: "TOKENROUTER_API_KEY is missing from the worker environment.",
      jobId: job.id,
      phase: "needs_attention",
    }).catch(() => {});
    return;
  }

  const settings = job.settings_snapshot || {};
  const baseUrl = gatewayBaseUrl(settings);
  const models = chatModels(settings);
  const judges = chatJudges(settings);
  if (models.length < 2) {
    throw new Error("Cloud Council needs at least two chat-compatible TokenRouter models.");
  }

  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    await addEvent(
      job.id,
      "warn",
      "benchmark_setup",
      "GitHub token is missing; Codespaces benchmark execution is not available yet."
    );
  }

  if (executionProvider(settings) === "e2b" && !process.env.E2B_API_KEY) {
    await addEvent(
      job.id,
      "warn",
      "benchmark_setup",
      "E2B execution was requested but E2B_API_KEY is missing; benchmark runs will record setup failures."
    );
  }

  await patchJob(job.id, { progress_phase: "downloading_images" });
  await addEvent(job.id, "info", "downloading_images", "Downloading ordered screenshots from Supabase Storage.");
  const images = await downloadJobImages(job.id);
  if (!images.length) throw new Error("The job has no downloadable screenshots.");

  await patchJob(job.id, { progress_phase: "solving" });
  await addEvent(job.id, "info", "solving", `Asking ${models.length} independent Council solver models.`);

  const question = userPrompt("", true, "", images.map(() => ({})), "");
  const solverSystem = systemPrompt(settings.mode || "auto");
  const candidates = [];

  await Promise.all(
    models.map(async (spec, index) => {
      const letter = letterFor(index);
      try {
        const text = await tokenRouterChat({
          baseUrl,
          model: spec.id,
          system: solverSystem,
          user: question,
          images,
          maxTokens: Number(settings.maxTokens || 4096),
        });
        const final = parseFinal(text);
        candidates[index] = { letter, model: spec.id, final, text, error: null };
        await addEvent(job.id, "info", "solver_done", `${spec.id} answered as Candidate ${letter}.`, {
          model: spec.id,
          letter,
          hasFinal: Boolean(final),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        candidates[index] = { letter, model: spec.id, final: null, text: "", error: message };
        await addEvent(job.id, "warn", "solver_failed", `${spec.id} failed: ${message}`, {
          model: spec.id,
          letter,
        });
      }
    })
  );

  const answered = candidates.filter((candidate) => candidate?.text || candidate?.final);
  if (answered.length < 1) throw new Error("No Council solver produced an answer.");

  const field = candidates.filter(Boolean);
  const benchmark = await benchmarkCandidates(job, settings, baseUrl, models, judges, question, field);
  const docket = candidateDocket(field);
  const execution = benchmark.suites.length
    ? executionDigest(field, benchmark.runs)
    : "No benchmark evidence is available for this cloud Council run.";
  if (!benchmark.suites.length) {
    await addEvent(job.id, "warn", "benchmark_pending", execution);
  }

  await patchJob(job.id, { progress_phase: "reviewing" });
  await addEvent(job.id, "info", "reviewing", `Collecting ${models.length} Council review passes.`);
  const reviewSets = [];

  await Promise.all(
    models.map(async (spec) => {
      try {
        const text = await tokenRouterChat({
          baseUrl,
          model: spec.id,
          system: reviewSystemPrompt(),
          user: reviewUserPrompt({ question, docket, execution }),
          maxTokens: Number(settings.maxTokens || 4096),
        });
        const parsed = parseReviewSet(text, spec.id);
        reviewSets.push(parsed);
        await addEvent(job.id, "info", "review_done", `${spec.id} reviewed the candidate field.`, {
          model: spec.id,
          reviews: parsed.reviews.length,
          wellFormed: parsed.wellFormed,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await addEvent(job.id, "warn", "review_failed", `${spec.id} review failed: ${message}`, {
          model: spec.id,
        });
      }
    })
  );

  await patchJob(job.id, { progress_phase: "judging" });
  await addEvent(job.id, "info", "judging", `Collecting ${judges.length} judge reports.`);
  const judgeReports = [];

  await Promise.all(
    judges.map(async (judge) => {
      try {
        const text = await tokenRouterChat({
          baseUrl,
          model: judge.model,
          system: judgeSystemPrompt(judge.emphasis || "correctness"),
          user: judgeUserPrompt({
            question,
            docket,
            reviews: reviewDigest(reviewSets),
            execution,
          }),
          maxTokens: Number(settings.maxTokens || 4096),
        });
        judgeReports.push({ model: judge.model, emphasis: judge.emphasis || "correctness", text, error: null });
        await addEvent(job.id, "info", "judge_done", `${judge.model} wrote a judge report.`, {
          model: judge.model,
          emphasis: judge.emphasis || "correctness",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        judgeReports.push({ model: judge.model, emphasis: judge.emphasis || "correctness", text: "", error: message });
        await addEvent(job.id, "warn", "judge_failed", `${judge.model} judge failed: ${message}`, {
          model: judge.model,
          emphasis: judge.emphasis || "correctness",
        });
      }
    })
  );

  await patchJob(job.id, { progress_phase: "synthesizing" });
  await addEvent(job.id, "info", "synthesizing", "Synthesizing the cloud Council result.");

  const synthesisModel = models[0].id;
  const synthesis = await tokenRouterChat({
    baseUrl,
    model: synthesisModel,
    system: synthesisSystemPrompt(),
    user: synthesisUserPrompt({
      question,
      docket,
      reviews: reviewDigest(reviewSets) || "(no reviews were collected)",
      execution,
      judges: judgeDigest(judgeReports) || "(no judges were collected)",
    }),
    maxTokens: Number(settings.maxTokens || 4096),
  });

  const report = {
    candidates: field,
    suites: benchmark.suites,
    runs: benchmark.runs,
    revisedRuns: {},
    reviews: reviewSets,
    judges: judgeReports,
    synthesis,
    winner: winnerFromSynthesis(synthesis),
  };
  const markdown = await saveCouncilReport(job, report);

  await patchJob(job.id, {
    status: "completed",
    progress_phase: "completed",
    error: null,
    result_summary: synthesis.split("\n").find((line) => line.trim())?.slice(0, 500) || "Cloud Council completed.",
    finished_at: new Date().toISOString(),
  });
  await addEvent(job.id, "info", "completed", "Cloud Council job completed.", {
    markdownBytes: Buffer.byteLength(markdown, "utf8"),
  });
  await notify(job.id, APP_DISPLAY_NAME, "Council job completed.");
  if (process.env.CODE_AUDITOR_NOTIFY_COMPLETED === "true") {
    await notifyOps({
      title: "Council job completed",
      body: report.winner ? `Winner: ${report.winner}` : "No winner was selected.",
      jobId: job.id,
      phase: "completed",
    }).catch(() => {});
  }
}

export async function tick() {
  const queued = await nextQueuedJob();
  if (!queued) return false;
  const job = await claim(queued);
  if (!job) return true;
  const started = Date.now();
  try {
    await runCouncilJob(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureWorkerException(err, { jobId: job.id, phase: "failed" });
    await addEvent(job.id, "error", "failed", message).catch(() => {});
    await patchJob(job.id, {
      status: "failed",
      progress_phase: "failed",
      error: message,
      finished_at: new Date().toISOString(),
    }).catch(() => {});
    await notifyOps({
      level: "error",
      title: "Council job failed",
      body: message,
      jobId: job.id,
      phase: "failed",
    }).catch(() => {});
  } finally {
    const durationMs = Date.now() - started;
    if (durationMs > SLOW_JOB_MS) {
      await notifyOps({
        level: "warn",
        title: "Council job is slow",
        body: `Finished after ${Math.round(durationMs / 1000)} seconds.`,
        jobId: job.id,
        phase: "slow_job",
      }).catch(() => {});
    }
  }
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  console.log(`${APP_DISPLAY_NAME} cloud worker ${WORKER_ID} polling ${SUPABASE_URL}`);
  try {
    do {
      const worked = await tick();
      if (ONCE) break;
      if (!worked) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    } while (true);
  } finally {
    await closeObservability();
  }
}
