#!/usr/bin/env node
/**
 * Cloud solve worker.
 *
 * This process owns queued background jobs. It deliberately does not read local
 * Keychain secrets or screenshots: jobs arrive through Supabase rows and Storage,
 * while provider, GitHub Actions, E2B and APNs secrets come from server-side env.
 *
 * It runs the same Council the desktop app does: independent solver calls,
 * benchmark generation and execution, reviewer passes, a revision round with a
 * second execution of the revised field, judge passes and one synthesis pass.
 * The revision round is not optional polish — a cloud job that skipped it
 * shipped a measurably weaker answer than the same question asked in the app,
 * and nothing in the report said so.
 */

// Configuration lives in the database now. This import has a top-level await,
// so app_config is merged into process.env before anything below reads it.
import "./lib/config.mjs";

import { createSign } from "node:crypto";
import { runGithubBenchmark } from "./lib/githubBenchmark.mjs";
import { readFileSync } from "node:fs";
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
/**
 * The keys for whichever job is in hand.
 *
 * Provider keys belong to people now, not to the worker. `TOKENROUTER_API_KEY`
 * used to be a module constant read once at import — correct while one person
 * owned everything, and wrong the moment two accounts have their own, because
 * every job would then be solved with whoever's key happened to load first and
 * billed to them.
 *
 * The worker takes one job at a time, so a per-job scope is enough: load the
 * owner's keys when the job is claimed, drop them when it finishes. Anything not
 * set for that person falls through to the platform tier, and then to the
 * worker's own environment for settings that are genuinely worker-wide.
 */
let jobSecrets = null;

/** Platform rows are owned by the nil UUID. */
const PLATFORM_OWNER = "00000000-0000-0000-0000-000000000000";

/**
 * No falling back to the worker's own environment once a job has an owner.
 *
 * The obvious `jobSecrets?.get(name) ?? process.env[name]` reintroduces exactly
 * the bug this is meant to fix: a second account with no TokenRouter key saved
 * would silently be solved with whatever key the worker was started with — and
 * billed to that person. A job whose owner has not supplied a key must fail and
 * say so, not quietly spend someone else's money.
 *
 * When `jobSecrets` is null there is no owner to charge — an older job from
 * before phase 01, or the batch runner — and the worker's environment is the
 * only answer available.
 */
function secret(name) {
  if (jobSecrets) return String(jobSecrets.get(name) ?? "").trim();
  return String(process.env[name] ?? "").trim();
}

async function loadOwnerSecrets(ownerId) {
  if (!ownerId) {
    jobSecrets = null;
    return null;
  }
  jobSecrets = new Map();
  // Ordered so the platform tier arrives first and the person's own row
  // overwrites it — the nil UUID sorts before any real one.
  const rows =
    (await rest(
      `app_config?select=key,value,owner_id&secret=eq.true` +
        `&or=(owner_id.eq.${ownerId},owner_id.eq.${PLATFORM_OWNER})&order=owner_id.asc`
    )) ?? [];
  for (const row of rows) {
    if (row.value) jobSecrets.set(row.key, row.value);
  }
  return jobSecrets;
}
const WORKER_ID = process.env.CODE_AUDITOR_WORKER_ID || `worker-${process.pid}`;
const POLL_MS = Number(process.env.CODE_AUDITOR_WORKER_POLL_MS || 5000);
const ONCE = process.argv.includes("--once");
const STORAGE_BUCKET = "screenshots";
const APP_DISPLAY_NAME = "Council Editor";
const SLOW_JOB_MS = Number(process.env.CODE_AUDITOR_SLOW_JOB_MS || 180_000);

initObservability({ service: "cloud-worker", workerId: WORKER_ID });

const [
  { systemPrompt, userPrompt, imageManifest, solutionPolicy },
  { parseFinal },
  council,
  { resolveAnswerLanguage },
  { titleFor, isPlaceholder },
  extraction,
  { knowledgePackFor },
  knowledgeLibrary,
  mcq,
] = await Promise.all([
  import("../src/lib/prompts.ts"),
  import("../src/lib/parse.ts"),
  import("../src/lib/council.ts"),
  import("../src/lib/answerLanguage.ts"),
  import("../src/lib/title.ts"),
  import("../src/lib/extraction.ts"),
  import("../src/lib/knowledge.ts"),
  import("../src/lib/knowledgeLibrary.ts"),
  import("../src/lib/mcq.ts"),
]);

const { detectMcq, parseMcqAnswer } = mcq;
const { loadKnowledgeLibrary } = knowledgeLibrary;

/**
 * The library this job reasons from.
 *
 * Postgres is the shelf; the pack compiled into this build is the fallback. The
 * rows are loaded once and reused for the life of the process — a query per
 * lookup would be slower than the array it replaced, which is the version of
 * this worth not building.
 */
async function libraryFor(settings) {
  return loadKnowledgeLibrary({
    preferBundle: settings.knowledgeLibrary === "bundle",
    ttlMs: Number(process.env.CODE_AUDITOR_KNOWLEDGE_TTL_MS || 5 * 60_000),
    fetchRows: (table) => rest(`${table}?select=*`),
  });
}

const {
  EXTRACTION_SYSTEM,
  EMPTY_EXTRACTION,
  extractionUserPrompt,
  parseExtraction,
  compareExtractions,
  singleReading,
  readingMarkdown,
  renderForReasoning,
  chooseReaders,
  VISION_PREFERENCE,
  tieBreakSystemPrompt,
  tieBreakUserPrompt,
  parseTieBreak,
  applyTieBreak,
} = extraction;

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
  endpointForCouncilModel,
  enforceWinnerGate,
  harnessIsSuspect,
  letterFor,
  looksLikeCodingProblem,
  normalizeCodeLanguage,
  partitionByVision,
  answerStanding,
  gateFor,
  reachableSeats,
  reasoningFields,
  reasoningForModel,
  rejectedImages,
  rejectedReasoning,
  parseTestSuites,
  parseReviewSet,
  parseCouncilSynthesis,
  parseJudgeReport,
  decideWinner,
  buildPresentation,
  mutateCode,
  oracleDigest,
  oracleSuspicion,
  contractSystemPrompt,
  contractUserPrompt,
  contractQuery,
  parseProblemContract,
  mergeProblemContracts,
  contractBlock,
  reviewSystemPrompt,
  reviewUserPrompt,
  reviewsOf,
  reviseSystemPrompt,
  reviseUserPrompt,
  spliceSuite,
  synthesisSystemPrompt,
  synthesisUserPrompt,
  testSpecSystemPrompt,
  testSpecUserPrompt,
} = council;

const MAX_OUTPUT = 64 * 1024;
const LOCAL_RUN_TIMEOUT_MS = 20_000;
const REMOTE_RUN_TIMEOUT_MS = 120_000;
const TOKENROUTER_MIN_DELAY_MS = Number(process.env.CODE_AUDITOR_TOKENROUTER_MIN_DELAY_MS || 13_000);
const TOKENROUTER_JITTER_MS = Number(process.env.CODE_AUDITOR_TOKENROUTER_JITTER_MS || 1_500);
const TOKENROUTER_REQUEST_TIMEOUT_MS = Number(process.env.CODE_AUDITOR_TOKENROUTER_REQUEST_TIMEOUT_MS || 75_000);
/**
 * How many times a *timeout* is worth repeating. Deliberately not the same
 * budget as a 429.
 *
 * A rate limit is the gateway saying "not yet", and waiting is the correct
 * answer. A request that produced nothing at all in the whole timeout window is
 * a route that is not answering, and asking it twice more mostly buys two more
 * timeouts. On the lc4 run that arithmetic cost 99 seconds on a single review
 * from a model that had already timed out as a solver minutes earlier.
 */
/**
 * Routes that answered "I have no reasoning mode", remembered for the process.
 *
 * Learned rather than tabulated. A hardcoded list of which models think would be
 * wrong within a month, and wrong in the expensive direction: either paying for
 * a retry on every call to a model that never supported it, or never asking a
 * model that does.
 */
const noReasoning = new Set();

function thinkingBudget(effort) {
  return effort === "off"
    ? Math.max(5_000, TOKENROUTER_REQUEST_TIMEOUT_MS)
    : Math.max(5_000, TOKENROUTER_REASONING_TIMEOUT_MS);
}

/**
 * A thinking model needs longer than a talking one.
 *
 * Asking for high effort and then cutting the request off at the timeout that
 * suited a chat reply is how a good model gets benched for being thorough. The
 * plain timeout still applies to everything else.
 */
const TOKENROUTER_REASONING_TIMEOUT_MS = Number(
  process.env.CODE_AUDITOR_TOKENROUTER_REASONING_TIMEOUT_MS || 240_000
);

const TOKENROUTER_TIMEOUT_ATTEMPTS = Math.max(
  1,
  Number(process.env.CODE_AUDITOR_TOKENROUTER_TIMEOUT_ATTEMPTS || 2)
);
let tokenRouterNextAt = 0;
let tokenRouterQueue = Promise.resolve();

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
  return reachableSeats(configured, (m) => m?.id, settings?.availableModels).reachable
    // The Responses filter that used to live here dated from a worker that only
    // spoke chat-completions. It now speaks both, so dropping a seat the user
    // deliberately configured would be silently discarding their roster.
    .filter((model) => model?.id)
    .slice(0, Number(process.env.CODE_AUDITOR_WORKER_SOLVERS || 4));
}

function chatJudges(settings) {
  const configured = Array.isArray(settings?.councilJudges)
    ? settings.councilJudges
    : COUNCIL_DEFAULT_JUDGES;
  return reachableSeats(configured, (j) => j?.model, settings?.availableModels).reachable
    .filter((judge) => judge?.model)
    .slice(0, Number(process.env.CODE_AUDITOR_WORKER_JUDGES || 3));
}

function gatewayBaseUrl(settings) {
  return settings?.gatewayBaseUrl || "https://api.tokenrouter.com/v1";
}

function retryDelayMs(status, text, attempt) {
  if (status !== 429) return 0;
  const minuteLimit = /within\s+1\s+minutes?/i.test(text);
  const explicit = /retry(?:\s|-)?after["':\s]+(\d+)/i.exec(text);
  if (explicit) return Math.min(Number(explicit[1]) * 1000, 90_000);
  return minuteLimit ? 65_000 : Math.min(10_000 * 2 ** attempt, 60_000);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function tokenRouterTurn() {
  const run = tokenRouterQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, tokenRouterNextAt - now);
    if (waitMs > 0) await sleep(waitMs);
    const jitter = TOKENROUTER_JITTER_MS > 0 ? Math.floor(Math.random() * TOKENROUTER_JITTER_MS) : 0;
    tokenRouterNextAt = Date.now() + Math.max(0, TOKENROUTER_MIN_DELAY_MS) + jitter;
  });
  tokenRouterQueue = run.catch(() => {});
  await run;
}

async function tokenRouterChat({ baseUrl, model, system, user, images = [], maxTokens = 4096, reasoning = "off" }) {
  const content = [{ type: "text", text: user }];
  for (const image of images) {
    content.push({ type: "image_url", image_url: { url: image.dataUrl } });
  }

  let temperature = 0.2;
  let last = "";
  let timeouts = 0;
  let think = noReasoning.has(model) ? "off" : reasoning;
  for (let attempt = 0; attempt < 3; attempt++) {
    await tokenRouterTurn();
    const controller = new AbortController();
    const budget = thinkingBudget(think);
    const timeout = setTimeout(() => controller.abort(), budget);
    let resp;
    try {
      resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${secret("TOKENROUTER_API_KEY")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
          max_tokens: maxTokens,
          temperature,
          ...reasoningFields(think, "chat"),
        }),
      });
    } catch (err) {
      if (err?.name === "AbortError") {
        timeouts += 1;
        last = `request timed out after ${budget}ms (attempt ${timeouts})`;
        if (timeouts < TOKENROUTER_TIMEOUT_ATTEMPTS) continue;
        // Tell the caller it was time, not content, that failed — the circuit
        // breaker upstream uses this to bench the route for the rest of the job.
        const timedOut = new Error(`${model}: ${last}`);
        timedOut.timedOut = true;
        throw timedOut;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    const text = await resp.text();
    last = `${resp.status} ${resp.statusText}: ${text}`;
    if (resp.ok) {
      const json = JSON.parse(text);
      const answer = json?.choices?.[0]?.message?.content;
      if (answer?.trim()) return answer;

      // A 200 carrying no content is the router, not the model: it is listed as
      // available, the request was accepted, and the backing route returned
      // nothing. It clears on its own within minutes.
      //
      // This used to throw here, outside the retry loop, so a transient blank
      // reply killed the seat outright — which is exactly what
      // "moonshotai/kimi-k3: empty model response" was in Sentry, twice, for
      // one run. Retrying costs one more request against a limit the pacing
      // queue already respects.
      last = `${model}: empty model response`;
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      break;
    }

    // The route has no reasoning mode. That is a fact about the route, not a
    // failure of the seat: drop the fields, remember it, and ask again.
    if (think !== "off" && rejectedReasoning(text)) {
      noReasoning.add(model);
      think = "off";
      // Not a failed attempt: nothing was wrong with the request except a field
      // this route does not have. Spending a retry slot on it would leave a
      // model that both refuses reasoning and hits a 429 with fewer chances
      // than one that never refused.
      attempt -= 1;
      continue;
    }

    if (/invalid temperature:\s*only\s*1\s*is\s*allowed/i.test(text) && temperature !== 1) {
      temperature = 1;
      continue;
    }

    const waitMs = retryDelayMs(resp.status, text, attempt);
    if (!waitMs || attempt === 2) break;
    await sleep(waitMs);
  }
  throw new Error(`${model}: ${last}`);
}

async function tokenRouterResponses({ baseUrl, model, system, user, images = [], maxTokens = 4096, reasoning = "off" }) {
  const content = [{ type: "input_text", text: user }];
  for (const image of images) {
    content.push({ type: "input_image", image_url: image.dataUrl });
  }

  let last = "";
  let timeouts = 0;
  let think = noReasoning.has(model) ? "off" : reasoning;
  for (let attempt = 0; attempt < 3; attempt++) {
    await tokenRouterTurn();
    const controller = new AbortController();
    const budget = thinkingBudget(think);
    const timeout = setTimeout(() => controller.abort(), budget);
    let resp;
    try {
      resp = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${secret("TOKENROUTER_API_KEY")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: system,
          input: [{ type: "message", role: "user", content }],
          max_output_tokens: maxTokens,
          temperature: 0.2,
          stream: false,
          ...reasoningFields(think, "responses"),
        }),
      });
    } catch (err) {
      if (err?.name === "AbortError") {
        timeouts += 1;
        last = `request timed out after ${budget}ms (attempt ${timeouts})`;
        if (timeouts < TOKENROUTER_TIMEOUT_ATTEMPTS) continue;
        const timedOut = new Error(`${model}: ${last}`);
        timedOut.timedOut = true;
        throw timedOut;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const text = await resp.text();
    last = `${resp.status} ${resp.statusText}: ${text}`;
    if (resp.ok) {
      const json = JSON.parse(text);
      const answer = responseText(json);
      if (answer.trim()) return answer;
      last = `${model}: empty model response`;
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      break;
    }

    if (think !== "off" && rejectedReasoning(text)) {
      noReasoning.add(model);
      think = "off";
      attempt -= 1;
      continue;
    }

    const waitMs = retryDelayMs(resp.status, text, attempt);
    if (!waitMs || attempt === 2) break;
    await sleep(waitMs);
  }
  throw new Error(`${model}: ${last}`);
}

function responseText(json) {
  let out = "";
  for (const item of json?.output || []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string") {
        out += part.text;
      }
    }
  }
  if (!out && typeof json?.output_text === "string") out = json.output_text;
  return out;
}

/**
 * One call, either wire.
 *
 * The endpoint comes from `endpointForCouncilModel`, the same function the
 * desktop uses, so a seat the user marked as Responses in Settings is dialled
 * that way here too. The worker previously consulted a hardcoded list of its
 * own and ignored the roster entirely, which meant the `endpoint` field on a
 * configured model did nothing on the cloud path.
 */
async function tokenRouterGenerate({ settings, ...args }) {
  const endpoint = endpointForCouncilModel(settings?.councilModels, args.model);
  // Decided here rather than at six call sites, so no phase can quietly forget
  // to ask a model to think.
  const reasoning = reasoningForModel(settings, args.model);
  const withThinking = { ...args, reasoning };
  return endpoint === "responses"
    ? tokenRouterResponses(withThinking)
    : tokenRouterChat(withThinking);
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

function isProviderQuotaError(message) {
  return /insufficient_user_quota|credit limit is insufficient|account quota is running low|please recharge/i.test(
    String(message || "")
  );
}

function isProviderRateLimit(message) {
  return /429 Too Many Requests|request limit|rate limit/i.test(String(message || ""));
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

const JAVA_COMMAND =
  "sed -E '/^public[[:space:]]+class[[:space:]]+Main\\b/!s/^public[[:space:]]+(class|interface|enum|record)[[:space:]]+/\\1 /' Main.java > _M.java && mv _M.java Main.java && javac Main.java && java Main";

function runtimeFor(language, code) {
  // Same normaliser the suites and the candidates go through, so a fence
  // labelled ```c++17 lands on the C++ row instead of falling off the table.
  const lang = normalizeCodeLanguage(language);
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
  if (lang === "java") {
    // `java Main.java` is single-file source mode: it runs the FIRST class in
    // the file, so a harness with the candidate's `Solution` spliced above its
    // own `Main` dies with "can't find main(String[]) method in class: Solution"
    // having never executed a line. That is exactly what killed Candidate A.
    // Compiling first and naming the entry class makes the order irrelevant.
    // The sed drops `public` from every top-level type except Main, because a
    // second public class in one file is a compile error and `public class
    // Solution` is the habit every LeetCode answer is written with.
    return { file: "Main.java", command: JAVA_COMMAND, runtime: "javac + java" };
  }
  if (["go", "golang"].includes(lang)) return { file: "main.go", command: "go run main.go", runtime: "go" };
  if (["rust", "rs"].includes(lang)) return { file: "main.rs", command: "rustc -O main.rs -o prog 2>&1 && ./prog", runtime: "rustc" };
  return null;
}

async function runLocalCode(language, code, timeoutMs = LOCAL_RUN_TIMEOUT_MS) {
  const runtime = runtimeFor(language, code);
  if (!runtime) throw new Error(`Unsupported benchmark language: ${language || "unknown"}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-editor-worker-"));
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

function remoteScript(language, code, providerLabel = "remote") {
  const encoded = Buffer.from(code, "utf8").toString("base64");
  return `set -u
tmp="$(mktemp -d "\${TMPDIR:-/tmp}/council-editor-bench.XXXXXX")" || exit 98
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
cd "$tmp" || exit 98
cat > code.b64 <<'CA_CODE'
${encoded}
CA_CODE
base64 -d code.b64 > code.txt
lang=${shellSingle(language)}
lang="$(printf '%s' "$lang" | tr '[:upper:]' '[:lower:]' | tr -d ' _-')"
# Fourth and last copy of the language table. Same standard-stripping as the
# local table and the Actions workflow,
# so a c++17 fence compiles here too instead of exiting 97 unrun.
case "$lang" in
  c++*|cpp*|cxx*) lang=cpp ;;
  c[0-9][0-9]) lang=c ;;
  python3.*) lang=python3 ;;
  node[0-9]*|es[0-9][0-9][0-9][0-9]) lang=javascript ;;
esac
case "$lang" in
  python|python3|py|py3) file=main.py; cp code.txt "$file"; command='python3 main.py'; runtime='${providerLabel} python3' ;;
  javascript|js|node|nodejs|mjs) file=main.mjs; cp code.txt "$file"; command='node main.mjs'; runtime='${providerLabel} node esm' ;;
  cjs) file=main.cjs; cp code.txt "$file"; command='node main.cjs'; runtime='${providerLabel} node commonjs' ;;
  typescript|ts) file=main.ts; cp code.txt "$file"; command='node --experimental-strip-types main.ts'; runtime='${providerLabel} node type stripping' ;;
  bash|sh|shell) file=main.sh; cp code.txt "$file"; command='bash main.sh'; runtime='${providerLabel} bash' ;;
  ruby|rb) file=main.rb; cp code.txt "$file"; command='ruby main.rb'; runtime='${providerLabel} ruby' ;;
  php) file=main.php; cp code.txt "$file"; command='php main.php'; runtime='${providerLabel} php' ;;
  c) file=main.c; cp code.txt "$file"; command='cc -std=c17 -O2 main.c -o prog -lm && ./prog'; runtime='${providerLabel} cc -O2' ;;
  cpp|c++|cc|cxx) file=main.cpp; cp code.txt "$file"; command='c++ -std=c++20 -O2 main.cpp -o prog && ./prog'; runtime='${providerLabel} c++ -O2' ;;
  java) file=Main.java; cp code.txt "$file"; command="${JAVA_COMMAND}"; runtime='${providerLabel} javac + java' ;;
  go|golang) file=main.go; cp code.txt "$file"; command='go run main.go'; runtime='${providerLabel} go' ;;
  rust|rs) file=main.rs; cp code.txt "$file"; command='rustc -O main.rs -o prog 2>&1 && ./prog'; runtime='${providerLabel} rustc -O' ;;
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
    runtime: runtime?.[1]?.trim() || "remote",
    remoteElapsedMs: metrics.elapsed_s ? Math.round(Number(metrics.elapsed_s) * 1000) : metrics.elapsed_ms ? Number(metrics.elapsed_ms) : null,
    peakMemoryKb: metrics.maxrss_kb ? Number(metrics.maxrss_kb) : null,
  };
}

/**
 * Optional second-pass benchmark evidence after E2B/local generated tests.
 * E2B is the default execution gate; Actions is heavier, reproducible evidence
 * for passing candidates only.
 */
/**
 * Where the *extra* remote measurement comes from, on top of the run that gates.
 *
 * This used to default to Actions whenever a repo was configured, so a candidate
 * was executed twice for one answer: once in the E2B sandbox to decide whether
 * it passes, and again on a GitHub runner to time it. E2B already reports
 * elapsed time and peak resident set — it runs the same metrics script — so the
 * second run bought a slightly different number at the cost of a dispatch, a
 * poll and an artifact download per candidate.
 *
 * The default is now "off": whatever ran the code is what measured it. Choosing
 * "actions" is an explicit decision to have GitHub do the measuring, for when a
 * neutral machine matters more than the minutes.
 */
export function resolveBenchmarkBackend(settings = {}, env = process.env) {
  const explicit = String(settings.benchmarkBackend || "").trim().toLowerCase();
  if (explicit === "actions") return repoFor(env) ? "actions" : "off";
  return "off";
}

/** The repo Actions dispatches against. */
export function repoFor(env = process.env) {
  return String(env.GITHUB_REPOSITORY || env.CODE_AUDITOR_GITHUB_REPOSITORY || "").trim();
}

async function runE2BCode(language, code, timeoutMs = REMOTE_RUN_TIMEOUT_MS) {
  const started = Date.now();
  const { Sandbox } = await import("@e2b/code-interpreter");
  const bootStarted = Date.now();
  const template = String(process.env.CODE_AUDITOR_E2B_TEMPLATE || "").trim();
  const opts = {
    timeoutMs: Math.max(timeoutMs + 30_000, 90_000),
    metadata: {
      app: "code-editor",
      workerId: WORKER_ID,
      purpose: "benchmark",
      template: template || "code-interpreter-v1",
    },
  };
  const sandbox = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
  const bootMs = Date.now() - bootStarted;
  try {
    let result;
    try {
      result = await sandbox.commands.run(`bash -lc ${shellSingle(remoteScript(language, code, "e2b"))}`, {
        timeoutMs,
      });
    } catch (err) {
      if (err?.result) {
        result = err.result;
      } else {
        throw err;
      }
    }
    const parsed = parseRemoteOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
    const out = clampOutput(parsed.stdout || result.stdout || "");
    const err = clampOutput(parsed.stderr || result.stderr || "");
    const exitCode = parsed.exitCode ?? result.exitCode ?? null;
    return {
      // A missing exit status must not be presented as a passing verification.
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
      bootMs,
    };
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

function executionProvider(settings) {
  // Never silently run untrusted generated code on the host when E2B is
  // unavailable. The local runner is an explicit operator-only selection.
  const selected = String(
    settings.executionProvider ||
      process.env.CODE_AUDITOR_EXECUTION_PROVIDER ||
      "e2b"
  ).trim().toLowerCase();
  if (selected !== "e2b" && selected !== "local") {
    throw new Error(`Unsupported execution provider: ${selected}`);
  }
  return selected;
}

async function runVerification(settings, suite, program) {
  const provider = executionProvider(settings);
  if (provider === "e2b") {
    if (!secret("E2B_API_KEY")) {
      throw new Error("No E2B key is saved for the account that owns this job.");
    }
    return runE2BCode(suite.language, program, Number(settings.e2bTimeoutMs || REMOTE_RUN_TIMEOUT_MS));
  }
  return runLocalCode(suite.language, program, LOCAL_RUN_TIMEOUT_MS);
}

/**
 * Run one field of candidates against the harnesses, once.
 *
 * Pulled out of `benchmarkCandidates` so the revision round executes through
 * exactly the same code as round one. Two copies of this loop would be two
 * places for the gate's evidence to be produced differently, which is the one
 * kind of drift the whole design is built to prevent.
 *
 * `revised: true` reads `candidate.revised` instead of `candidate.final`, and
 * skips any candidate that did not revise: an unrevised candidate has no second
 * run, and inventing one from its original would double-count the same evidence.
 */
async function executeField(job, settings, suites, candidates, opts = {}) {
  const revised = Boolean(opts.revised);
  const tag = revised ? " (revised)" : "";
  const runs = {};
  for (const candidate of candidates) {
    if (revised && !candidate.revised) continue;
    const final = revised ? (candidate.revised ?? null) : candidate.final;
    const lang = final?.kind === "code" ? candidateLanguage(final) : "";
    const suite = suites.find((s) => s.language === lang);
    const code = final?.code || "";
    if (!final || final.kind !== "code" || !code.trim()) {
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: final?.kind === "research" ? "research answer" : "no code", runtime: "" };
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
      const backend = resolveBenchmarkBackend(settings);
      // Only a candidate that already passed locally is worth a remote machine.
      // Benchmarking something that fails its own tests measures how fast it is
      // wrong, and spends a runner minute to find that out.
      const worthBenchmarking = local.ok && localCases.failed === 0 && localCases.passed > 0;

      if (worthBenchmarking && backend === "actions") {
        // Unique per candidate, not per job: the run is found again by its
        // display title, and two candidates of one job in the same language
        // would otherwise produce two runs nobody can tell apart.
        const correlationId = `${job.id}-${candidate.letter}${revised ? "-r" : ""}`;
        try {
          const gha = await runGithubBenchmark({
            repo: repoFor(),
            token: String(settings.githubToken || secret("CODE_AUDITOR_GITHUB_TOKEN") || secret("GITHUB_TOKEN") || ""),
            workflow: String(settings.githubWorkflow || process.env.CODE_AUDITOR_GITHUB_WORKFLOW || "cloud-benchmark.yml"),
            ref: String(settings.githubRef || process.env.CODE_AUDITOR_GITHUB_REF || "main"),
            correlationId,
            language: suite.language,
            program,
            timeoutMs: Number(settings.benchmarkTimeoutMs || 300_000),
            log: (line) => console.log(`[bench ${candidate.letter}] ${line}`),
          });
          remote = {
            ok: gha.ok,
            runner: "github-actions",
            runtime: gha.runtime,
            durationMs: gha.durationMs,
            remoteElapsedMs: gha.remoteElapsedMs ?? null,
            peakMemoryKb: gha.peakMemoryKb ?? null,
            note: gha.note || (gha.ok ? "benchmarked on GitHub Actions" : "benchmark failed"),
            url: gha.url ?? null,
          };
        } catch (err) {
          remote = {
            ok: false,
            runner: "github-actions",
            runtime: "github-actions",
            durationMs: 0,
            remoteElapsedMs: null,
            peakMemoryKb: null,
            note: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // A bare "exit 1" says a candidate failed but not whether the code was
      // wrong or the generated harness was — and that is exactly the line the
      // "objective failure outranks consensus" rule is drawn on. Keep the first
      // few lines of what the compiler or runtime actually said.
      const diagnostic = String(local.stderr || "").trim().split("\n").slice(0, 6).join("\n");
      // A program that never started did not fail its tests — the harness did.
      // Naming it distinctly keeps a build problem out of the evidence the
      // judges weigh, where it would read as "this candidate is wrong".
      const brokenHarness =
        /could not find or load main class|error: cannot find symbol|no such file or directory|command not found|compilation failed|error: expected/i.test(
          diagnostic
        );
      runs[candidate.letter] = {
        letter: candidate.letter,
        ran: true,
        ok: local.ok,
        passed: localCases.passed,
        failed: localCases.failed,
        durationMs: local.durationMs,
        note: local.timedOut
          ? "timed out"
          : brokenHarness
            ? "the generated harness did not build or start"
            : local.exitCode !== 0
              ? `exit ${local.exitCode}`
              : "",
        runtime: local.runtime,
        // Whatever ran it measured it. These come back from the same metrics
        // script the remote runners use, and dropping them was the reason a
        // second run on Actions looked necessary at all.
        remoteElapsedMs: local.remoteElapsedMs ?? null,
        peakMemoryKb: local.peakMemoryKb ?? null,
        provider: local.provider || executionProvider(settings),
        stderr: diagnostic,
        remote,
      };
      await addEvent(job.id, local.ok && localCases.failed === 0 ? "info" : "warn", "benchmark_done", `Candidate ${candidate.letter}${tag}: ${runs[candidate.letter].note || `${localCases.passed} case(s) passed`}.${diagnostic ? ` — ${diagnostic.split("\n")[0]}` : ""}`, runs[candidate.letter]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: message, runtime: "" };
      await addEvent(job.id, "warn", "benchmark_failed", `Candidate ${candidate.letter}${tag} benchmark failed: ${message}`, runs[candidate.letter]);
    }
  }

  return runs;
}

/**
 * Is the harness worth believing?
 *
 * One deliberately broken copy of a candidate that passed, run through the same
 * suite. A harness that passes it has not verified anything it accepted, and
 * until now nothing in the pipeline could notice that: the gate can only reject
 * what its evidence rejects, and evidence that accepts everything rejects
 * nothing.
 *
 * One execution, of code that already compiled, on a program the runner has
 * already proven it can run. It buys a signal nothing else in the system can
 * produce.
 */
async function runMutationOracle(job, settings, suites, candidates, runs) {
  const passing = candidates.find((c) => gateFor(runs[c.letter]) === "pass" && c.final?.code?.trim());
  if (!passing) return [];
  const suite = suites.find((s) => s.language === candidateLanguage(passing.final));
  if (!suite) return [];
  const mutation = mutateCode(passing.final.code);
  if (!mutation.applied) return [];
  const program = spliceSuite(suite, mutation.code);
  if (!program) return [];

  try {
    const local = await runVerification(settings, suite, program);
    const cases = countCases(local.stdout);
    const survived = local.ok && cases.failed === 0 && cases.passed > 0;
    const signal = {
      kind: "mutation",
      letter: passing.letter,
      ran: true,
      survived,
      description: mutation.description,
      note: survived ? `${cases.passed} case(s) passed on a broken program` : `${cases.failed} case(s) caught the break`,
    };
    await addEvent(
      job.id,
      survived ? "warn" : "info",
      survived ? "harness_undiscriminating" : "oracle_ok",
      survived
        ? `The harness passed a deliberately broken Candidate ${passing.letter} (${mutation.description}).`
        : `The harness caught a deliberately broken Candidate ${passing.letter} (${mutation.description}).`,
      signal
    );
    return [signal];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addEvent(job.id, "info", "oracle_skipped", `The mutation check could not run: ${message}`);
    return [];
  }
}

async function benchmarkCandidates(job, settings, baseUrl, models, judges, question, candidates, knowledge = "", bench) {
  const codeCandidates = candidates.filter((c) => c.final?.kind === "code" && c.final.code?.trim());
  if (codeCandidates.length < 2) {
    await addEvent(
      job.id,
      "info",
      "benchmark_skipped",
      "Fewer than two runnable code candidates; MCQ, math, research and plain-answer jobs use Council reasoning validation instead of code execution."
    );
    return { suites: [], runs: {}, oracles: [] };
  }

  await patchJob(job.id, { progress_phase: "speccing" });
  await addEvent(job.id, "info", "speccing", "Generating language-specific benchmark harnesses.");
  const languages = Array.from(new Set(codeCandidates.map((c) => candidateLanguage(c.final)).filter(Boolean)));
  // A benched route would spend the whole timeout again on the one call the
  // benchmark phase cannot proceed without.
  const specModel = [settings.synthesisModel, judges[0]?.model, ...models.map((m) => m.id)].find(
    (candidate) => candidate && !bench.has(candidate)
  );
  if (!specModel) {
    await addEvent(job.id, "warn", "spec_failed", "Every model is benched, so no benchmark harness could be generated.");
    return { suites: [], runs: {}, oracles: [] };
  }
  let suites = [];
  try {
    const specText = await tokenRouterGenerate({
      settings,
      baseUrl,
      model: specModel,
      system: testSpecSystemPrompt(),
      user: testSpecUserPrompt({
        question,
        docket: candidateDocket(candidates),
        languages,
        knowledge: knowledge || settings.knowledgeDigest || "",
      }),
      maxTokens: Number(settings.maxTokens || 4096),
    });
    suites = parseTestSuites(specText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await bench.note(specModel, err, "speccing");
    await addEvent(job.id, "warn", "spec_failed", `Benchmark spec generation failed: ${message}`);
    return { suites: [], runs: {}, oracles: [] };
  }

  if (!suites.length) {
    await addEvent(job.id, "warn", "benchmark_skipped", "The benchmark spec did not contain any runnable harnesses.");
    return { suites, runs: {}, oracles: [] };
  }

  await patchJob(job.id, { progress_phase: "verifying" });
  await addEvent(job.id, "info", "verifying", `Running ${codeCandidates.length} candidates through generated benchmarks.`);
  const runs = await executeField(job, settings, suites, candidates);
  const oracles = await runMutationOracle(job, settings, suites, candidates, runs);
  return { suites, runs, oracles };
}

/**
 * A route that ran out of time once does not get asked again this job.
 *
 * The Council asks the same models over and over — read, solve, spec, review,
 * judge, synthesise. Nothing remembered that a model had already failed to
 * answer, so a dead route was re-asked at every stage and charged the full
 * timeout each time. On the lc4 run `moonshotai/kimi-k2.7-code` timed out as a
 * solver and was then asked to review, where it timed out again: 99 seconds
 * spent on a question whose answer was already known.
 *
 * Only timeouts bench a model. A refusal, a bad status, a malformed reply are
 * all answers — the route is alive and might do better on a different prompt.
 * Silence is the one failure that repeats.
 */
function createBench(job) {
  const out = new Map();
  const blind = new Map();
  return {
    has: (model) => out.has(model),
    /** Proven, this run, to refuse a picture rather than the prompt. */
    isBlind: (model) => blind.has(model),
    /**
     * A route that rejected the image itself.
     *
     * Vision is a property of the route and can only be proven by showing it
     * something. Nothing was writing that proof down — only timeouts benched a
     * model — so a route that refuses pictures was handed the same one on every
     * job forever. It keeps its seat, because it can still read and judge text;
     * it just stops being shown images.
     */
    async noteBlind(model, message, phase) {
      if (!rejectedImages(message || "") || blind.has(model)) return blind.has(model);
      blind.set(model, phase);
      await addEvent(
        job.id,
        "warn",
        "model_blind",
        `${model} refused the image during ${phase}; it is not shown pictures again this run. Mark it "text only" in the roster to skip it permanently.`,
        { model, phase }
      ).catch(() => {});
      return true;
    },
    keep: (list, pick = (x) => x) => list.filter((item) => !out.has(pick(item))),
    async note(model, err, phase) {
      if (!err?.timedOut || out.has(model)) return out.has(model);
      out.set(model, phase);
      await addEvent(
        job.id,
        "warn",
        "model_benched",
        `${model} ran out of time during ${phase}; it is skipped for the rest of this job.`,
        { model, phase }
      ).catch(() => {});
      return true;
    },
    async announce(phase, skipped) {
      if (!skipped.length) return;
      await addEvent(job.id, "info", "phase_skipped", `Skipping ${skipped.join(", ")} for ${phase} — already benched.`, {
        models: skipped,
        phase,
      }).catch(() => {});
    },
    list: () => [...out.entries()].map(([model, phase]) => ({ model, phase })),
  };
}

/**
 * Turns the job's pictures into a document, before anybody tries to solve them.
 *
 * The desktop app has always done this. The cloud worker never did: it handed
 * four models a raw PNG and the sentence "Solve the attached problem", because
 * `solve_jobs` carries no note and no extraction column, so there was nothing
 * else to hand them. Two consequences followed from that one gap. A model whose
 * route does not carry images could not take part at all. And there was no text
 * to search the knowledge pack with, so the knowledge pack was never searched --
 * `knowledgeDigest` had exactly one consumer and nothing ever set it.
 *
 * Reading first fixes both. The picture becomes words; the words select the
 * knowledge; the knowledge and the words go to every model, seeing or blind.
 *
 * Two readers when there are two, because a single transcription that misreads a
 * character reaches the whole panel as fact and nothing contradicts it. When
 * only one answers the reading still proceeds, but it says so -- `singleReading`
 * writes the doubt into the document rather than leaving it implied.
 */
async function readScreenshots({ job, settings, baseUrl, models, images, imageRefs, bench }) {
  const manifest = imageManifest(imageRefs);
  // Ranked, not arbitrary. Reading a screenshot of code or a diagram is its own
  // skill, and the seat that happened to be first in the roster is not the one
  // you want doing it. The third strongest is held back: it is asked only if
  // the first two disagree, and asking one of the two whether it was wrong is
  // not an answer.
  const pool = bench.keep(models, (m) => m.id);
  const { readers, tieBreaker } = chooseReaders(
    pool,
    (m) => m.id,
    Array.isArray(settings.visionPreference) && settings.visionPreference.length
      ? settings.visionPreference
      : VISION_PREFERENCE,
    Math.max(1, Number(process.env.CODE_AUDITOR_WORKER_READERS || 2))
  );
  if (!readers.length) {
    await addEvent(job.id, "warn", "reading_none", "No model was available to read the screenshot.");
    return { extraction: null, context: "", markdown: "", readers: [], agreement: null };
  }

  await patchJob(job.id, { progress_phase: "reading" });
  await addEvent(job.id, "info", "reading", `Transcribing ${images.length} screenshot(s) with ${readers.length} reader(s).`);

  const done = [];
  await Promise.all(
    readers.map(async (spec) => {
      try {
        const text = await tokenRouterGenerate({
          settings,
          baseUrl,
          model: spec.id,
          system: EXTRACTION_SYSTEM,
          user: extractionUserPrompt("", manifest),
          images,
          maxTokens: Number(settings.maxTokens || 4096),
        });
        const parsed = parseExtraction(text);
        if (!parsed) {
          await addEvent(job.id, "warn", "reading_unparsed", `${spec.id} answered but the reading did not parse.`, { model: spec.id });
          return;
        }
        done.push({ model: spec.id, extraction: parsed });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await bench.note(spec.id, err, "reading");
        await bench.noteBlind(spec.id, message, "reading");
        await addEvent(job.id, "warn", "reading_failed", `${spec.id} could not read the screenshot: ${message}`, { model: spec.id });
      }
    })
  );

  if (!done.length) {
    // Not fatal. The images still go to the solvers, so a vision-capable model
    // can work; what is lost is the knowledge pack and the blind models.
    await addEvent(job.id, "warn", "reading_none", "No model produced a usable reading; solving from the images alone.");
    return { extraction: EMPTY_EXTRACTION, context: "", markdown: "", readers: [], agreement: null };
  }

  let agreement =
    done.length > 1
      ? compareExtractions(done[0].extraction, done[1].extraction)
      : singleReading(done[0].extraction, `only ${done[0].model} answered`);

  const readerNames = done.map((d) => d.model);
  let resolved = agreement;
  if (done.length > 1 && !agreement.agree) {
    await addEvent(job.id, "warn", "reading_conflict", `The readers disagree: ${agreement.summary}`, {
      readers: readerNames,
      conflicts: agreement.conflicts,
    });

    // A third pair of eyes on the disputed fields only. Cheaper than it looks —
    // one call, no solving — and it replaces the rule it used to fall back on,
    // which was "whichever model claimed more confidence wins", a number a
    // model writes about itself.
    const disputed = agreement.conflicts.filter((c) => c.severity === "high");
    if (tieBreaker && disputed.length) {
      try {
        const text = await tokenRouterGenerate({
          settings,
          baseUrl,
          model: tieBreaker.id,
          system: tieBreakSystemPrompt(),
          user: tieBreakUserPrompt(disputed, manifest),
          images,
          maxTokens: Math.min(Number(settings.maxTokens || 4096), 1024),
        });
        const picks = parseTieBreak(text, disputed.map((c) => c.field));
        resolved = applyTieBreak(done[0].extraction, done[1].extraction, agreement, picks, tieBreaker.id);
        await addEvent(
          job.id,
          resolved.agree ? "info" : "warn",
          "reading_tiebreak",
          picks.length
            ? `${tieBreaker.id} settled ${picks.map((p) => `${p.field}→${p.choice.toUpperCase()}`).join(", ")}.`
            : `${tieBreaker.id} was asked to settle the reading but named no field.`,
          { model: tieBreaker.id, picks, unresolved: !resolved.agree }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await bench.note(tieBreaker.id, err, "reading_tiebreak");
        await addEvent(job.id, "warn", "reading_tiebreak_failed", `${tieBreaker.id} could not settle the reading: ${message}`);
      }
    }
  }
  agreement = resolved;

  const merged = agreement.merged;
  const markdown = readingMarkdown(merged, {
    readers: readerNames,
    agreement: done.length > 1 ? agreement : null,
    manifest,
    at: new Date().toISOString(),
  });

  await addEvent(job.id, "info", "reading_done", `Read by ${readerNames.join(", ")} — confidence ${merged.confidence}.`, {
    readers: readerNames,
    agree: agreement.agree,
    language: merged.language,
    confidence: merged.confidence,
    ambiguities: merged.ambiguities,
    markdownBytes: Buffer.byteLength(markdown, "utf8"),
  });

  return { extraction: merged, context: renderForReasoning(merged), markdown, readers: readerNames, agreement };
}

/**
 * The slice of the knowledge library this particular question needs.
 *
 * `knowledgePackFor` retrieves against text, which is why this cannot run before
 * the reading. A caller may override it outright via `settings.knowledgeDigest`;
 * otherwise the query is what the readers actually saw -- the summary of what is
 * being asked, anything they noted, and the transcribed code.
 */
async function selectKnowledge(job, settings, { candidates = [], reading = null, contract = null } = {}) {
  const override = String(settings.knowledgeDigest || "").trim();
  if (override) {
    await addEvent(job.id, "info", "knowledge_selected", "Using the knowledge digest supplied with the job.", {
      source: "settings",
      bytes: Buffer.byteLength(override, "utf8"),
    });
    return override;
  }

  // The contract first, when there is one. It describes the problem rather than
  // one model's attempt at it, and it exists before anybody has attempted
  // anything — which is what lets the library reach the first solve instead of
  // arriving after the answers it was supposed to inform.
  const fromContract = contractQuery(contract);
  // Failing that, the panel's own answers: the first text in the pipeline
  // written by something that understood the question, and available without
  // spending a call to produce it. A transcript, when one exists because
  // nothing could see, is folded in as well.
  const fromCandidates = candidates
    .map((c) => [c.final?.answer, c.final?.complexity, c.final?.code].filter((part) => part?.trim()).join("\n"))
    .filter(Boolean)
    .join("\n\n");
  const e = reading?.extraction;
  const fromReading = e
    ? [e.problemSummary, (e.observations || []).join("\n"), e.code].filter((part) => part?.trim()).join("\n\n")
    : "";
  const query = [fromContract, fromCandidates, fromReading].filter(Boolean).join("\n\n");
  if (!query.trim()) {
    await addEvent(job.id, "warn", "knowledge_skipped", "Nothing produced text to search the knowledge library with.");
    return "";
  }

  const limit = Math.max(1, Number(settings.knowledgeLimit || 5));
  const library = await libraryFor(settings);
  const pack = knowledgePackFor(query, limit, library.records);
  await addEvent(
    job.id,
    pack.trim() ? "info" : "warn",
    "knowledge_selected",
    pack.trim()
      ? `Selected ${limit} knowledge record(s) for this question from the ${library.source}.`
      : `The knowledge library returned nothing for this question (${library.records.length} record(s) searched).`,
    {
      source: "library",
      from: fromContract ? "contract" : fromCandidates ? "answers" : "reading",
      // Which shelf this run reasoned from. The app carries its own compiled
      // copy, so without this a report cannot say whether two runs of the same
      // question even had the same library in front of them.
      library: library.source,
      libraryNote: library.note,
      records: library.records.length,
      limit,
      bytes: Buffer.byteLength(pack, "utf8"),
      queryBytes: Buffer.byteLength(query, "utf8"),
    }
  );
  return pack;
}

/**
 * Name the session after the question, once the question is known.
 *
 * A cloud job arrives before anybody has read the picture, so the session is
 * created under whatever placeholder the caller had — "Batch — lc4", "Cloud
 * smoke 2026-08-27T02:07:42.817Z". Those are scaffolding. By the time the panel
 * has answered, the run can name itself after what it actually worked on, which
 * is the only version of the name that helps you find it again a week later.
 *
 * A title a person typed is never touched: `isPlaceholder` is the whole guard,
 * and renaming someone's session out from under them is how an app stops being
 * trusted with their data.
 */
/**
 * What the problem asks, settled before anybody answers it.
 *
 * Two readers, not one: a single reading that is wrong is promoted to ground
 * truth by every prompt downstream, and nothing afterwards can contradict it.
 * Two readings can disagree, and a disagreement carried openly into the
 * contract is worth more than a confident sentence nobody checked.
 *
 * Cheap by design — two calls, no solving, no images beyond the ones the
 * solvers were going to be shown anyway — and skipped outright when the run has
 * fewer than two reachable seats or the owner turned it off.
 */
async function readProblemContract({ job, settings, baseUrl, models, images, question, reading, bench }) {
  if (settings.councilProblemContract === false) return { contract: null, agreement: null, readers: [] };
  const seats = bench.keep(models, (m) => m.id).slice(0, 2);
  if (!seats.length) return { contract: null, agreement: null, readers: [] };

  await addEvent(job.id, "info", "problem_contract", `Reading the problem with ${seats.length} reader(s) before solving.`, {
    models: seats.map((m) => m.id),
  });
  const readings = [];
  await Promise.all(
    seats.map(async (spec) => {
      try {
        const text = await tokenRouterGenerate({
          settings,
          baseUrl,
          model: spec.id,
          system: contractSystemPrompt(),
          user: contractUserPrompt({ question, reading: reading?.markdown || reading?.context || "" }),
          images,
          maxTokens: Math.min(Number(settings.maxTokens || 4096), 2048),
        });
        const parsed = parseProblemContract(text);
        if (parsed.wellFormed) readings.push(parsed);
        else await addEvent(job.id, "warn", "problem_contract_unparsed", `${spec.id} answered but the contract did not parse.`, { model: spec.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await bench.note(spec.id, err, "problem_contract");
        await bench.noteBlind(spec.id, message, "problem_contract");
        await addEvent(job.id, "warn", "problem_contract_failed", `${spec.id} could not read the problem: ${message}`, { model: spec.id });
      }
    })
  );

  const { contract, agreement } = mergeProblemContracts(readings);
  if (!contract) {
    // Not fatal. The council has always run without one; the contract makes the
    // run better, and a run that proceeds without it is the old behaviour, not
    // a broken one.
    await addEvent(job.id, "warn", "problem_contract_none", "No reader produced a usable problem contract; solving from the problem as given.");
    return { contract: null, agreement: null, readers: seats.map((m) => m.id) };
  }
  await addEvent(
    job.id,
    agreement?.agree === false ? "warn" : "info",
    "problem_contract_done",
    agreement?.agree === false
      ? `The readers disagreed about the problem: ${agreement.differences[0]}`
      : "The readers agreed on what the problem asks.",
    { agree: agreement?.agree ?? null, differences: agreement?.differences ?? [], readers: seats.map((m) => m.id) }
  );
  return { contract, agreement, readers: seats.map((m) => m.id) };
}

async function nameSessionFromWork(job, reading, candidates) {
  if (!job.session_id) return;
  try {
    const suggested = titleFor({
      extraction: reading?.extraction ?? null,
      answers: candidates
        .map((c) => c.final)
        .filter(Boolean)
        .map((f) => ({ answer: f.answer, language: f.language, code: f.code })),
    });
    if (!suggested) return;

    const [session] = (await rest(`sessions?id=eq.${job.session_id}&select=title`)) ?? [];
    if (!session || !isPlaceholder(String(session.title || ""))) return;

    await rest(`sessions?id=eq.${job.session_id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: suggested }),
    });
    await addEvent(job.id, "info", "session_named", `Named this session "${suggested}".`, {
      title: suggested,
      from: reading?.extraction ? "reading" : "answers",
    });
  } catch (err) {
    // A name is a convenience. Losing one must never cost a completed run.
    await addEvent(
      job.id,
      "warn",
      "session_name_failed",
      `Could not name the session: ${err instanceof Error ? err.message : String(err)}`
    ).catch(() => {});
  }
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

async function saveMcqReport(job, answer, reading, raw = "") {
  const markdown = [
    `# MCQ Answer`,
    "",
    `**Answer:** ${answer.answer?.label || ""}${answer.answer?.text ? ` — ${answer.answer.text}` : ""}`,
    "",
    answer.reason || "",
    "",
    answer.whyNot?.length ? "## Why the others are not best" : "",
    ...(answer.whyNot || []).map((x) => `- ${x.label}: ${x.reason}`),
  ].filter(Boolean).join("\n");
  const report = {
    kind: "mcq",
    ...answer,
    reading: {
      readers: reading?.readers || [],
      agree: reading?.agreement?.agree ?? null,
      confidence: reading?.extraction?.confidence ?? 0,
      markdown: reading?.markdown || "",
    },
    raw,
  };
  await rest("council_reports", {
    method: "POST",
    body: JSON.stringify({
      job_id: job.id,
      session_id: job.session_id,
      winner: answer.answer?.label || null,
      synthesis: answer.reason || "",
      markdown,
      report,
    }),
  });
  return markdown;
}

function mcqSystemPrompt() {
  return [
    "You answer multiple-choice questions from screenshots.",
    "First use any LOCAL KNOWLEDGE section as the preferred source. If it does not directly answer the question, reason from the question and choices.",
    "Return ONLY JSON with this exact shape:",
    '{"kind":"mcq","question":"...","options":[{"label":"A","text":"..."}],"answer":{"label":"A","text":"..."},"reason":"why this answer is valid","whyNot":[{"label":"B","reason":"why not"}],"knowledgeUsed":false,"model":"MODEL_ID"}',
  ].join("\n");
}

function mcqUserPrompt({ readingText, knowledge, detection, model }) {
  return [
    "QUESTION / SCREEN READING",
    readingText || "(No reliable transcription was produced; use the attached image if present.)",
    "",
    detection?.options?.length ? `DETECTED OPTIONS\n${detection.options.map((o) => `${o.label}. ${o.text}`).join("\n")}` : "",
    "",
    knowledge?.trim() ? `LOCAL KNOWLEDGE\n${knowledge.trim()}` : "LOCAL KNOWLEDGE\nNo local exact answer was found.",
    "",
    `Set model to ${model}. Choose the single best answer and explain why it beats the other choices.`,
  ].filter(Boolean).join("\n");
}

function mcqEndpointFor(settings, model) {
  if (settings?.mcqEndpoint === "chat" || settings?.mcqEndpoint === "responses") return settings.mcqEndpoint;
  return endpointForCouncilModel(settings?.councilModels, model);
}

async function mcqGenerate({ settings, baseUrl, model, system, user, images = [], maxTokens = 2048 }) {
  const args = { baseUrl, model, system, user, images, maxTokens, reasoning: reasoningForModel(settings, model) };
  return mcqEndpointFor(settings, model) === "responses"
    ? tokenRouterResponses(args)
    : tokenRouterChat(args);
}

function mcqModel(settings, models) {
  const preferred = String(settings?.mcqModel || "anthropic/claude-fable-5").trim();
  const available = reachableSeats([{ id: preferred }], (m) => m?.id, settings?.availableModels).reachable;
  if (available.length) return preferred;
  return models[0]?.id || preferred;
}

async function runMcqJob(job, { images = null, reading = null, bench = null } = {}) {
  await addEvent(job.id, "info", "claimed", "Cloud worker claimed the MCQ job.");
  await notify(job.id, APP_DISPLAY_NAME, "MCQ job started.");
  await addEvent(job.id, "info", "mcq", "MCQ overlay workflow selected.");
  await loadOwnerSecrets(job.owner_id);
  if (!secret("TOKENROUTER_API_KEY")) {
    const message = "No TokenRouter key is saved for the account that owns this job.";
    await addEvent(job.id, "error", "needs_attention", message);
    await patchJob(job.id, { status: "needs_attention", progress_phase: "needs_attention", error: message, finished_at: new Date().toISOString() });
    return;
  }

  const settings = job.settings_snapshot || {};
  const baseUrl = gatewayBaseUrl(settings);
  const roster = Array.isArray(settings.councilModels) && settings.councilModels.length
    ? settings.councilModels
    : COUNCIL_DEFAULT_MODELS;
  const models = reachableSeats(roster, (m) => m?.id, settings.availableModels).reachable;
  const model = mcqModel(settings, models);
  const localBench = bench || createBench(job);

  await patchJob(job.id, { progress_phase: "mcq_reading", mode: "mcq" });
  const jobImages = images || await downloadJobImages(job.id);
  const imageRefs = jobImages.map((img) => ({ group: String(img.fileName || "") }));
  const readerPool = partitionByVision(
    localBench.keep([{ id: model }, ...models], (m) => m.id),
    (m) => m.id,
    settings.probes,
    settings.councilModels
  ).seeing.filter((m) => !localBench.isBlind(m.id));
  const mcqReading = reading || await readScreenshots({
    job,
    settings,
    baseUrl,
    models: readerPool.length ? readerPool : [{ id: model }],
    images: jobImages,
    imageRefs,
    bench: localBench,
  });
  const readingText = [mcqReading.context, mcqReading.markdown].filter(Boolean).join("\n\n");
  const detection = detectMcq(readingText);
  const mcqLibrary = await libraryFor(settings);
  const knowledge = knowledgePackFor(
    [detection.question, ...detection.options.map((o) => `${o.label}. ${o.text}`), readingText].filter(Boolean).join("\n"),
    Math.max(1, Number(settings.knowledgeLimit || 5)),
    mcqLibrary.records
  );
  await addEvent(job.id, knowledge.trim() ? "info" : "warn", "knowledge_selected", knowledge.trim() ? `Checked the ${mcqLibrary.source} knowledge library before MCQ solving.` : "The knowledge library had no matching MCQ guidance.", {
    library: mcqLibrary.source,
    records: mcqLibrary.records.length,
    bytes: Buffer.byteLength(knowledge || "", "utf8"),
    options: detection.options.length,
  });

  await patchJob(job.id, { progress_phase: "mcq_solving" });
  const raw = await mcqGenerate({
    settings,
    baseUrl,
    model,
    system: mcqSystemPrompt(),
    user: mcqUserPrompt({ readingText, knowledge, detection, model }),
    images: detection.isMcq ? [] : jobImages,
    maxTokens: Math.min(Number(settings.maxTokens || 4096), 4096),
  });
  const parsed = parseMcqAnswer(raw, {
    question: detection.question,
    options: detection.options,
    knowledgeUsed: Boolean(knowledge.trim()),
    model,
  });
  if (!parsed?.answer?.label && !parsed?.answer?.text) {
    throw new Error("The MCQ model answered, but no selected answer could be parsed.");
  }
  parsed.model = parsed.model || model;
  parsed.knowledgeUsed = Boolean(parsed.knowledgeUsed || knowledge.trim());
  const markdown = await saveMcqReport(job, parsed, mcqReading, raw);
  await patchJob(job.id, {
    status: "completed",
    progress_phase: "completed",
    mode: "mcq",
    error: null,
    result_summary: `${parsed.answer.label ? `${parsed.answer.label}: ` : ""}${parsed.answer.text || parsed.reason}`.slice(0, 500),
    finished_at: new Date().toISOString(),
  });
  await addEvent(job.id, "info", "completed", "MCQ job completed.", { markdownBytes: Buffer.byteLength(markdown, "utf8"), model });
  await notify(job.id, APP_DISPLAY_NAME, "MCQ answer ready.");
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function apnsPrivateKey() {
  const inline = process.env.APNS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (inline?.trim()) return inline;

  const privateKeyPath = process.env.APNS_PRIVATE_KEY_PATH?.trim();
  if (!privateKeyPath) return "";

  const resolved = path.resolve(process.cwd(), privateKeyPath);
  return readFileSync(resolved, "utf8");
}

function apnsToken() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const privateKey = apnsPrivateKey();
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
  let token;
  try {
    token = apnsToken();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureWorkerException(err, { jobId, phase: "notify" });
    await addEvent(jobId, "warn", "notify", `APNs private key could not be loaded: ${message}`);
    return;
  }
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
  if (job.mode === "mcq") {
    await runMcqJob(job);
    return;
  }

  await addEvent(job.id, "info", "claimed", "Cloud worker claimed the job.");
  await notify(job.id, APP_DISPLAY_NAME, "Council job started.");

  // Whose job is this, and therefore whose keys pay for it.
  await loadOwnerSecrets(job.owner_id);

  if (!secret("TOKENROUTER_API_KEY")) {
    await addEvent(
      job.id,
      "error",
      "needs_attention",
      "No TokenRouter key is saved for the account that owns this job."
    );
    await patchJob(job.id, {
      status: "needs_attention",
      progress_phase: "needs_attention",
      error: "No TokenRouter key is saved for the account that owns this job.",
      finished_at: new Date().toISOString(),
    });
    await notify(job.id, APP_DISPLAY_NAME, "Council job needs TokenRouter configuration.");
    await notifyOps({
      level: "warn",
      title: "Council job needs attention",
      body: "No TokenRouter key is saved for the account that owns this job.",
      jobId: job.id,
      phase: "needs_attention",
    }).catch(() => {});
    return;
  }

  const settings = job.settings_snapshot || {};
  const baseUrl = gatewayBaseUrl(settings);
  const models = chatModels(settings);
  const judges = chatJudges(settings);

  // A seat the key has no access to is not worth a request to discover. The
  // router's catalogue already answered that for every model at once, so the
  // seat is dropped here — but never silently, because a roster that quietly
  // shrinks is how a four-solver Council becomes a two-solver Council without
  // anyone noticing.
  const missing = [
    ...reachableSeats(
      Array.isArray(settings.councilModels) ? settings.councilModels : COUNCIL_DEFAULT_MODELS,
      (m) => m?.id,
      settings.availableModels
    ).unreachable.map((m) => m.id),
    ...reachableSeats(
      Array.isArray(settings.councilJudges) ? settings.councilJudges : COUNCIL_DEFAULT_JUDGES,
      (j) => j?.model,
      settings.availableModels
    ).unreachable.map((j) => j.model),
  ];
  if (missing.length) {
    await addEvent(
      job.id,
      "warn",
      "seats_unreachable",
      `This key cannot reach ${missing.join(", ")}, so those seats are not used.`,
      { models: missing, catalogueSize: settings.availableModels?.length ?? 0 }
    );
  }
  if (models.length < 2) {
    throw new Error(
      missing.length
        ? `Cloud Council needs at least two reachable models, and this key cannot reach ${missing.join(", ")}. ` +
          "Refresh the model list in Settings, or put reachable ids in the roster."
        : "Cloud Council needs at least two chat-compatible TokenRouter models."
    );
  }

  if (!secret("CODE_AUDITOR_GITHUB_TOKEN") && !secret("GITHUB_TOKEN") && !secret("GH_TOKEN")) {
    await addEvent(
      job.id,
      "warn",
      "benchmark_setup",
      "GitHub token is missing; GitHub Actions benchmark evidence will be skipped until the worker has an Actions-write token."
    );
  }

  if (executionProvider(settings) === "e2b" && !secret("E2B_API_KEY")) {
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

  // Real references, in the order the images are attached, so the manifest can
  // say whether these are separate problems or one screen cut into pieces.
  // Passing `{}` per image, as this did, produced a manifest that described
  // nothing.
  const imageRefs = images.map((img) => ({ group: String(img.fileName || ""), }));

  const bench = createBench(job);

  // The picture goes to the models that can be shown a picture. The rest sit the
  // round out rather than being handed a transcription to guess from: a
  // transcription is a lossy copy of the evidence, and an answer derived from
  // one is worth less than no answer from that seat at all. Vision belongs to
  // the route, not the model, so a measured probe outranks every table.
  const available = bench.keep(models, (m) => m.id);
  const partitioned = partitionByVision(available, (m) => m.id, settings.probes, settings.councilModels);
  const seeing = partitioned.seeing.filter((m) => !bench.isBlind(m.id));
  const resting = [...partitioned.resting, ...partitioned.seeing.filter((m) => bench.isBlind(m.id))];
  if (resting.length) {
    await addEvent(
      job.id,
      "info",
      "models_resting",
      `${resting.map((m) => m.id).join(", ")} cannot be shown an image on this route, so they sit this question out.`,
      { models: resting.map((m) => m.id) }
    );
  }

  // Transcription is off by default for pure coding runs, but Auto overlay mode
  // needs a short read before solving so it can decide whether this is MCQ or
  // coding. That keeps MCQ a sibling of the existing overlay mechanism instead
  // of a separate manual-only path.
  const mustTranscribe = seeing.length === 0;
  /**
   * Where the solvers get the problem from.
   *
   *   "image"   — every seat that can see is shown the screenshot (the old way)
   *   "reading" — nobody solves from pixels; the reconstruction is the problem
   *   "auto"    — the reconstruction when two readers agreed on it, the picture
   *               as well when they did not
   *
   * "auto" is the default because the two claims pull against each other and
   * the evidence decides which wins. Reading a screenshot is a different skill
   * from solving what is in it, and a reconstruction two strong readers agree on
   * is usually a cleaner problem statement than a JPEG of an IDE — but a
   * reconstruction they disputed is the one thing worse than pixels, so that is
   * exactly when the picture travels too.
   */
  const solveFrom = String(settings.solveFrom || "auto");
  const wantsTranscript =
    settings.transcribeScreenshots === true ||
    mustTranscribe ||
    settings.overlayMode === "auto" ||
    solveFrom !== "image";

  // Readers are drawn from the whole reachable roster, not from the four solver
  // seats. This used to hand the picture to `available` — which, when the
  // fallback fires, is by definition the models that cannot be shown one. The
  // single case the fallback exists for was the single case it could not work
  // in, and it spent two calls and half a minute of pacing proving it.
  const roster = Array.isArray(settings.councilModels) && settings.councilModels.length
    ? settings.councilModels
    : COUNCIL_DEFAULT_MODELS;
  const readerPool = partitionByVision(
    bench.keep(reachableSeats(roster, (m) => m?.id, settings.availableModels).reachable, (m) => m.id),
    (m) => m.id,
    settings.probes,
    settings.councilModels
  ).seeing.filter((m) => !bench.isBlind(m.id));

  if (mustTranscribe) {
    if (!readerPool.length) {
      // Nothing anywhere can be shown this picture. Saying so is the useful
      // answer; spending eight model calls to arrive at an empty reading and
      // four guesses made from it is not.
      throw new Error(
        "No model this key can reach is able to read a screenshot. Add a vision-capable seat to the roster, " +
          "or run the image check in Settings if one of these can in fact see."
      );
    }
    await addEvent(
      job.id,
      "warn",
      "no_seeing_models",
      `No solver seat can be shown this screenshot, so ${readerPool.map((m) => m.id).join(", ")} transcribe it instead.`,
      { readers: readerPool.map((m) => m.id) }
    );
  }

  const reading = wantsTranscript
    ? await readScreenshots({ job, settings, baseUrl, models: readerPool, images, imageRefs, bench })
    : { extraction: null, context: "", markdown: "", readers: [], agreement: null };

  const overlayReadingText = [reading.context, reading.markdown].filter(Boolean).join("\n\n");
  if (settings.overlayMode === "auto" && overlayReadingText && detectMcq(overlayReadingText).isMcq) {
    await addEvent(job.id, "info", "mcq_detected", "Auto overlay mode detected multiple-choice answer options.");
    await runMcqJob({ ...job, settings_snapshot: settings, mode: "mcq" }, { images, reading, bench });
    return;
  }

  // Is the reconstruction worth solving from on its own?
  //
  // Only when two readers looked and did not disagree — or disagreed and a
  // third settled it — and the reading is not hedging about its own confidence.
  const readingTrusted =
    Boolean(reading.extraction) &&
    (reading.readers?.length ?? 0) >= 2 &&
    reading.agreement?.agree !== false &&
    Number(reading.extraction?.confidence ?? 0) >= Number(settings.readingConfidenceFloor ?? 0.7);

  const showPicture =
    solveFrom === "image" ? true : solveFrom === "reading" ? false : !readingTrusted;

  // Who actually solves. When the picture stays behind, a seat that cannot see
  // is no longer at a disadvantage, so the whole reachable bench solves rather
  // than only the models with eyes — which is the other half of separating
  // reconstruction from solving.
  let solving = showPicture && seeing.length ? seeing : available;
  const solveImages = showPicture && seeing.length ? images : [];
  if (!showPicture) {
    await addEvent(
      job.id,
      "info",
      "solving_from_reading",
      `The screenshot was reconstructed by ${(reading.readers || []).join(", ") || "the readers"}; the solvers work from that rather than the pixels.`,
      { readers: reading.readers, confidence: reading.extraction?.confidence ?? null, solveFrom }
    );
  }

  await patchJob(job.id, { progress_phase: "solving" });

  // Everything the desktop path sends, which until now none of was sent: the
  // reading of the picture, the knowledge selected for this question, a real
  // manifest, and the house preference for what to write it in.
  const policy = solutionPolicy(
    Array.isArray(settings.solutionLanguages) && settings.solutionLanguages.length
      ? settings.solutionLanguages
      : undefined,
    Number(settings.memoryTargetKb || 20 * 1024)
  );
  // No knowledge argument here on purpose. `knowledgePackFor` retrieves against
  // text, and before anybody has answered there is no text — only a picture.
  // The library arrives the moment the panel produces words, which is also the
  // moment the system can tell this is a coding problem at all.
  const baseQuestion = userPrompt("", solveImages.length > 0, reading.context, imageRefs, "", policy);

  // Everything downstream — solvers, the harness spec, reviews, revisions,
  // judges, the synthesis — is handed this same string as "the problem". Folding
  // the contract into it once is what makes it immutable ground truth for the
  // whole run rather than a paragraph one stage happened to be given.
  const contracting = await readProblemContract({
    job,
    settings,
    baseUrl,
    models: solving,
    images: solveImages,
    question: baseQuestion,
    reading,
    bench,
  });
  const contractText = contractBlock(contracting.contract);
  const question = contractText ? `${baseQuestion}\n\n---\n\n${contractText}` : baseQuestion;

  // The library, before the first attempt rather than after it.
  //
  // Retrieval matches text against text, and a screenshot is not text — which
  // is why this used to wait until the solvers had written something and then
  // hand the library to every round except the one that produced the answers.
  // The contract is text about the problem, written before anybody attempted
  // it, so the pack can reach round one now. Only for problems the readers
  // called code: retrieving cp-algorithms and perf counters for a
  // multiple-choice question is noise charged four times over.
  let knowledge =
    contracting.contract?.kind === "code"
      ? await selectKnowledge(job, settings, { contract: contracting.contract, reading })
      : "";
  const solverPrompt = [
    userPrompt("", solveImages.length > 0, reading.context, imageRefs, knowledge, policy),
    contractText,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  // The contract pass is the cheapest call of the run, which makes it the right
  // place to find out a route is dead. A model that timed out reading the
  // problem is not asked to solve it: the solver list is rebuilt from the bench
  // rather than fixed before anybody had been asked anything.
  const stillLive = bench.keep(solving, (m) => m.id);
  if (stillLive.length && stillLive.length < solving.length) {
    const dropped = solving.filter((m) => bench.has(m.id)).map((m) => m.id);
    await addEvent(
      job.id,
      "info",
      "phase_skipped",
      `${dropped.join(", ")} did not answer the contract pass, so the solve round does not ask again.`,
      { models: dropped }
    );
    solving = stillLive;
  }

  // Same rule as the desktop run: the answer comes back in the language the
  // question was posed in, unless the setting names one. The reading is where
  // that language finally comes from — `job.extraction` was never a column, so
  // this had silently resolved to "unknown" on every cloud run ever made.
  const answerLanguage = resolveAnswerLanguage(
    String(settings.outputLanguage || ""),
    String(reading.extraction?.language || "")
  );
  await addEvent(job.id, "info", "answer_language", `Answering in ${answerLanguage.display || "the question's own language"}.`, {
    id: answerLanguage.id,
    source: answerLanguage.source,
  });
  const solverSystem = systemPrompt(settings.mode || "auto", answerLanguage);
  const candidates = [];

  await bench.announce("solving", models.filter((m) => bench.has(m.id)).map((m) => m.id));
  await addEvent(
    job.id,
    "info",
    "solving",
    seeing.length
      ? `Asking ${solving.length} model(s) that can read the screenshot to solve it directly.`
      : `Asking ${solving.length} model(s) to solve from the transcription.`,
    { models: solving.map((m) => m.id), fromImage: seeing.length > 0 }
  );
  await Promise.all(
    solving.map(async (spec, index) => {
      const letter = letterFor(index);
      try {
        const text = await tokenRouterGenerate({
          settings,
          baseUrl,
          model: spec.id,
          system: solverSystem,
          user: solverPrompt,
          images: solveImages,
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
        await bench.note(spec.id, err, "solving");
        await bench.noteBlind(spec.id, message, "solving");
        await addEvent(job.id, "warn", "solver_failed", `${spec.id} failed: ${message}`, {
          model: spec.id,
          letter,
        });
      }
    })
  );

  const answered = candidates.filter((candidate) => candidate?.text || candidate?.final);
  if (answered.length < 1) {
    const errors = candidates.filter(Boolean).map((candidate) => candidate.error || "").filter(Boolean);
    const quota = errors.find(isProviderQuotaError);
    const rateLimit = errors.find(isProviderRateLimit);
    if (quota || rateLimit) {
      const reason = quota
        ? "TokenRouter quota is exhausted; add credit or switch the worker to another reachable model/key."
        : "TokenRouter rate limit blocked every solver; the worker should retry later.";
      await addEvent(job.id, "warn", "needs_attention", reason);
      await patchJob(job.id, {
        status: "needs_attention",
        progress_phase: "needs_attention",
        error: reason,
        finished_at: new Date().toISOString(),
      });
      await notifyOps({
        level: "warn",
        title: "Council job needs attention",
        body: reason,
        jobId: job.id,
        phase: "needs_attention",
      }).catch(() => {});
      return;
    }
    throw new Error("No Council solver produced an answer.");
  }

  const field = candidates.filter(Boolean);

  // What kind of question was it? Asked of the answers, not of the picture: a
  // panel that came back with code has settled that more reliably than any
  // classifier run over the pixels beforehand could have.
  // Named here rather than at the end: the answers are in hand, and a run that
  // fails later should still have left a session you can recognise.
  await nameSessionFromWork(job, reading, field);

  const isCoding = looksLikeCodingProblem(field);
  await addEvent(
    job.id,
    "info",
    "problem_kind",
    isCoding
      ? "The panel answered with code, so this is treated as a coding problem: the knowledge library and the performance targets apply."
      : "No candidate produced code, so this is not treated as a coding problem.",
    { coding: isCoding, kinds: field.map((c) => c.final?.kind || null) }
  );

  // The library only comes out for the problems it was written for. It is a
  // benchmarking and optimisation collection — cp-algorithms, getrusage, perf
  // counters, criterion — and feeding it to a multiple-choice question would be
  // noise charged four times over.
  // Already selected from the contract in the usual case. This is the fallback
  // for a run whose readers produced nothing usable — and for one the contract
  // called something other than code while the answers say otherwise, which is
  // the reading being wrong rather than the panel.
  if (!knowledge && isCoding) {
    knowledge = await selectKnowledge(job, settings, { candidates: field, reading });
  }

  const benchmark = await benchmarkCandidates(job, settings, baseUrl, models, judges, question, field, knowledge, bench);
  const docket = candidateDocket(field);
  // An execution backend that is down makes every candidate "untested", which
  // reads exactly like every candidate being useless. It is not the same thing
  // and the record should not imply it is.
  const attempted = Object.values(benchmark.runs).filter((r) => r?.note && !r.ran);
  const infraFailures = attempted.filter((r) =>
    /sandbox|e2b|timed out|econn|network|unauthor|api key|rate limit/i.test(String(r.note))
  );
  if (benchmark.suites.length && infraFailures.length && infraFailures.length === attempted.length) {
    await addEvent(
      job.id,
      "error",
      "benchmark_backend_down",
      `No candidate could be executed at all — the execution backend looks unavailable: ${infraFailures[0].note}`,
      { provider: executionProvider(settings), notes: infraFailures.map((r) => r.note) }
    );
  }

  const oracles = benchmark.oracles || [];
  const suspectHarness = [harnessIsSuspect(benchmark.runs), oracleSuspicion(oracles)].filter(Boolean).join("\n\n");
  if (suspectHarness) {
    await addEvent(job.id, "warn", "harness_suspect", suspectHarness, { runs: benchmark.runs });
  }
  const execution = benchmark.suites.length
    ? // The doubt travels with the evidence rather than beside it, so reviews,
      // judges and the synthesis all read it in the same breath as the scores
      // they would otherwise take at face value.
      [
        executionDigest(field, benchmark.runs),
        oracleDigest(oracles),
        suspectHarness && `NOTE ON THE HARNESS: ${suspectHarness}`,
      ]
        .filter(Boolean)
        .join("\n\n")
    : "No benchmark evidence is available for this cloud Council run.";
  if (!benchmark.suites.length) {
    await addEvent(job.id, "warn", "benchmark_pending", execution);
  }

  await patchJob(job.id, { progress_phase: "reviewing" });

  const reviewSets = [];

  const reviewing = bench.keep(models, (m) => m.id);
  await bench.announce("reviewing", models.filter((m) => bench.has(m.id)).map((m) => m.id));
  await addEvent(job.id, "info", "reviewing", `Collecting ${reviewing.length} Council review passes.`);
  await Promise.all(
    reviewing.map(async (spec) => {
      try {
        const text = await tokenRouterGenerate({
          settings,
          baseUrl,
          model: spec.id,
          system: reviewSystemPrompt(),
          user: reviewUserPrompt({ question, docket, execution, knowledge }),
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
        await bench.note(spec.id, err, "reviewing");
        await addEvent(job.id, "warn", "review_failed", `${spec.id} review failed: ${message}`, {
          model: spec.id,
        });
      }
    })
  );

  // ------------------------------------------------------------ round 3: revise
  //
  // The desktop council revises after review and re-executes the revised field;
  // the cloud worker used to stop after one solve pass and ship `revisedRuns: {}`.
  // That was the largest parity gap in the product: the same question, asked
  // through the helper instead of the app, got a measurably weaker answer for no
  // reason a user could see.
  //
  // Reviews that parsed to nothing mean the council has nothing new to teach its
  // solvers, and a revision round over zero critiques is N requests spent
  // re-answering a question already answered.
  let field3 = field;
  let revisedRuns = {};
  if (reviewSets.some((set) => set.reviews.length > 0)) {
    await patchJob(job.id, { progress_phase: "revising" });
    const revising = bench.keep(
      field.filter((c) => c.final || c.text),
      (c) => c.model
    );
    await bench.announce("revising", field.filter((c) => bench.has(c.model)).map((c) => c.model));
    await addEvent(job.id, "info", "revising", `Asking ${revising.length} solver(s) to revise after review.`);
    const revisions = new Map();
    await Promise.all(
      revising.map(async (candidate) => {
        const received = reviewsOf(reviewSets, candidate.letter)
          .map((r) => `- [${r.reviewer}] correct: ${r.correct}. ${r.problems}`)
          .join("\n");
        try {
          const text = await tokenRouterGenerate({
            settings,
            baseUrl,
            model: candidate.model,
            system: reviseSystemPrompt(),
            user: reviseUserPrompt({
              question,
              letter: candidate.letter,
              ownRaw: candidate.final?.raw ?? candidate.text,
              docket,
              received,
              execution,
              knowledge,
            }),
            maxTokens: Number(settings.maxTokens || 4096),
          });
          // A malformed revision is not silently adopted. The original stays the
          // candidate and the gate keeps judging the thing that actually ran.
          const parsed = parseFinal(text);
          if (parsed) revisions.set(candidate.letter, { final: parsed, text });
          await addEvent(
            job.id,
            parsed ? "info" : "warn",
            parsed ? "revision_done" : "revision_unparsed",
            parsed
              ? `${candidate.model} revised Candidate ${candidate.letter}.`
              : `${candidate.model} answered but the revision of Candidate ${candidate.letter} did not parse; the original stands.`,
            { model: candidate.model, letter: candidate.letter }
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await bench.note(candidate.model, err, "revising");
          await addEvent(job.id, "warn", "revision_failed", `${candidate.model} revision failed: ${message}`, {
            model: candidate.model,
            letter: candidate.letter,
          });
        }
      })
    );

    field3 = field.map((c) => {
      const rev = revisions.get(c.letter);
      return rev ? { ...c, revised: rev.final, revisedText: rev.text } : c;
    });

    if (benchmark.suites.length && field3.some((c) => c.revised)) {
      await patchJob(job.id, { progress_phase: "reverifying" });
      await addEvent(job.id, "info", "reverifying", "Re-running the revised field against the same harnesses.");
      revisedRuns = await executeField(job, settings, benchmark.suites, field3, { revised: true });
    }
  }

  const revisedAny = field3.some((c) => c.revised);
  // Both dockets and both digests from here on. The judge and synthesis prompts
  // already speak of revisions; until now nothing was putting any in front of them.
  const docketBoth = revisedAny
    ? `${candidateDocket(field3)}\n\n=== REVISED ===\n\n${candidateDocket(field3, { revised: true })}`
    : docket;
  const executionBoth = [
    execution,
    revisedAny && Object.keys(revisedRuns).length
      ? `=== REVISED RUNS ===\n${executionDigest(field3, revisedRuns, { revised: true })}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  await patchJob(job.id, { progress_phase: "judging" });

  const judgeReports = [];

  const judging = bench.keep(judges, (j) => j.model);
  await bench.announce("judging", judges.filter((j) => bench.has(j.model)).map((j) => j.model));
  await addEvent(job.id, "info", "judging", `Collecting ${judging.length} judge reports.`);
  await Promise.all(
    judging.map(async (judge) => {
      try {
        const text = await tokenRouterGenerate({
          settings,
          baseUrl,
          model: judge.model,
          system: judgeSystemPrompt(judge.emphasis || "correctness"),
          user: judgeUserPrompt({
            question,
            docket: docketBoth,
            reviews: reviewDigest(reviewSets),
            execution: executionBoth,
            knowledge,
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
        await bench.note(judge.model, err, "judging");
        await addEvent(job.id, "warn", "judge_failed", `${judge.model} judge failed: ${message}`, {
          model: judge.model,
          emphasis: judge.emphasis || "correctness",
        });
      }
    })
  );

  await patchJob(job.id, { progress_phase: "synthesizing" });
  await addEvent(job.id, "info", "synthesizing", "Synthesizing the cloud Council result.");

  const synthesisModel =
    [settings.synthesisModel, ...judges.map((j) => j.model), ...models.map((m) => m.id)].find(
      (id) => id && !bench.has(id)
    ) || models[0].id;
  let synthesis;
  try {
    synthesis = await tokenRouterGenerate({
      settings,
      baseUrl,
      model: synthesisModel,
      system: synthesisSystemPrompt(),
      user: synthesisUserPrompt({
        question,
        docket: docketBoth,
        reviews: reviewDigest(reviewSets) || "(no reviews were collected)",
        execution: executionBoth,
        judges: judgeDigest(judgeReports) || "(no judges were collected)",
        knowledge,
      }),
      maxTokens: Number(settings.maxTokens || 4096),
    });
  } catch (err) {
    // Reviews and judges each survive their own failure; synthesis was a bare
    // await, so one refused request at the last step threw away every solver
    // answer and every benchmark measurement the run had already paid for.
    // The job still fails — a Council result without a synthesis is not a
    // result — but nothing is lost silently any more: what the run did produce
    // goes into the log first, so a failed run can still be read afterwards.
    const message = err instanceof Error ? err.message : String(err);
    await addEvent(job.id, "error", "synthesis_failed", `Synthesis failed on ${synthesisModel}: ${message}`, {
      model: synthesisModel,
      // What the run got as far as, so the spend is auditable even in failure.
      solvers: field.map((c) => ({
        letter: c.letter,
        model: c.model,
        answered: Boolean(c.text || c.final),
        kind: c.final?.kind || null,
        language: c.final?.kind === "code" ? candidateLanguage(c.final) : null,
        codeBytes: c.final?.code ? Buffer.byteLength(c.final.code, "utf8") : 0,
        error: c.error || null,
      })),
      benchmark: Object.values(benchmark.runs).map((run) => ({
        letter: run.letter,
        ran: run.ran,
        ok: run.ok,
        passed: run.passed,
        failed: run.failed,
        durationMs: run.durationMs,
        note: run.note,
        stderr: run.stderr || "",
      })),
      reviewsCollected: reviewSets.length,
      judgesCollected: judgeReports.filter((j) => j.text).length,
      judgesFailed: judgeReports.filter((j) => j.error).map((j) => ({ model: j.model, error: j.error })),
    }).catch(() => {});
    captureWorkerException(err, { jobId: job.id, phase: "synthesis_failed", model: synthesisModel });
    throw err;
  }

  // The gate, applied to the synthesis in code rather than asked for in a
  // prompt. On the first real run the synthesis named a candidate whose program
  // never started, described the failure as an environmental timeout, and built
  // the final answer on it. It never argued with the rule — it re-described the
  // evidence until the rule appeared not to apply. A model cannot re-describe
  // its way past this.
  // The synthesis, as fields rather than prose. Everything downstream — the
  // panel, the helper overlay, the dossier below — reads these instead of
  // scraping markdown, so a model drifting from the report format degrades one
  // parser rather than every surface at once.
  const parsedSynthesis = parseCouncilSynthesis(synthesis);
  const judgeReadings = judgeReports.map((j) => ({
    model: j.model,
    emphasis: j.emphasis,
    error: j.error,
    ...parseJudgeReport(j.text),
  }));
  const claimed = parsedSynthesis.winner || winnerFromSynthesis(synthesis);
  // A revised candidate is judged on its revision. Gating the revision's winner
  // against round one's run would reject a candidate for a defect it fixed —
  // and, worse, could pass one whose fix broke something.
  const gateRuns = {};
  for (const c of field3) {
    const run = c.revised ? revisedRuns[c.letter] : benchmark.runs[c.letter];
    if (run) gateRuns[c.letter] = run;
  }
  const ruling = enforceWinnerGate(claimed, gateRuns);

  // Scoring is counting, and counting does not need a language model. The gate
  // decides what may win, the judges' Borda tally decides between what is left,
  // and the synthesis narrates the result it no longer gets to choose.
  const decision = decideWinner({
    claimed,
    judges: judgeReadings,
    runs: gateRuns,
    letters: field3.map((c) => c.letter),
  });
  if (decision.disagreement) {
    await addEvent(job.id, "warn", "winner_aggregated", decision.disagreement, {
      claimedWinner: claimed,
      winner: decision.winner,
      source: decision.source,
      tally: decision.tally,
    });
  }

  // And the question the gate does not ask: is the text a person is about to
  // paste into an editor backed by anything that ran?
  const standing = answerStanding(decision.winner, gateRuns);
  if (standing.standing === "unverified") {
    await addEvent(job.id, "warn", "answer_unverified", standing.reason, {
      claimedWinner: claimed,
      gates: Object.fromEntries(Object.values(gateRuns).map((r) => [r.letter, gateFor(r)])),
    });
  }
  if (ruling.overruledReason) {
    await addEvent(job.id, "warn", "gate_overrule", ruling.overruledReason, {
      claimedWinner: claimed,
      run: gateRuns[claimed] || null,
    });
  }

  const report = {
    candidates: field3,
    suites: benchmark.suites,
    runs: benchmark.runs,
    revisedRuns,
    reviews: reviewSets,
    judges: judgeReports,
    // Stamped at the top, not appended at the bottom. A warning below a code
    // block is a warning nobody reads before copying the code block.
    synthesis: [
      standing.standing === "unverified"
        ? `> **UNVERIFIED ANSWER.** ${standing.reason}\n`
        : standing.standing === "unexecuted"
          ? `> **NOT EXECUTED.** ${standing.reason}\n`
          : "",
      synthesis,
      ruling.overruledReason ? `\n\n---\n\n**GATE OVERRULE.** ${ruling.overruledReason}` : "",
      decision.disagreement ? `\n\n---\n\n**JUDGE AGGREGATE.** ${decision.disagreement}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    standing: standing.standing,
    standingReason: standing.reason,
    // The dossier: what the report says, in fields a UI can render without
    // reading a word of the prose above it.
    parsed: {
      synthesis: parsedSynthesis,
      judges: judgeReadings,
      tally: decision.tally,
      winnerSource: decision.source,
      disagreement: decision.disagreement,
    },
    synthesisClaimedWinner: claimed,
    gateOverruleReason: ruling.overruledReason,
    harnessSuspect: suspectHarness,
    oracles,
    reading: {
      readers: reading.readers,
      agree: reading.agreement?.agree ?? null,
      confidence: reading.extraction?.confidence ?? 0,
      markdown: reading.markdown,
    },
    contract: contracting.contract,
    contractAgreement: contracting.agreement,
    contractReaders: contracting.readers,
    knowledgeBytes: Buffer.byteLength(knowledge || "", "utf8"),
    winner: decision.winner,
  };
  // Built from the finished report rather than assembled alongside it, so the
  // helper overlay and the app render the same fields from the same source.
  report.presentation = buildPresentation(report);
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
    const needsAttention = isProviderQuotaError(message) || isProviderRateLimit(message);
    captureWorkerException(err, { jobId: job.id, phase: "failed" });
    await addEvent(job.id, needsAttention ? "warn" : "error", needsAttention ? "needs_attention" : "failed", message).catch(() => {});
    await patchJob(job.id, {
      status: needsAttention ? "needs_attention" : "failed",
      progress_phase: needsAttention ? "needs_attention" : "failed",
      error: message,
      finished_at: new Date().toISOString(),
    }).catch(() => {});
    await notifyOps({
      level: needsAttention ? "warn" : "error",
      title: needsAttention ? "Council job needs attention" : "Council job failed",
      body: message,
      jobId: job.id,
      phase: needsAttention ? "needs_attention" : "failed",
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
