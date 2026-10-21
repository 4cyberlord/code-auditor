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

import { createHash, createHmac, createSign } from "node:crypto";
import { buildProvidedHarness, buildGeneratedPythonHarness, pythonHarnessJsonSystemPrompt, extractProvidedFixtures, providedCaseEvidence, requiredHarnessCases } from "../src/lib/providedCaseHarness.ts";
import { configuredCodeLanguage, providedTestBrief } from "../src/lib/primaryDeliveryPolicy.ts";
import { secondaryCouncilLanguages, independentLanguageInstruction, independentLanguageQuestion, independentJudgesReady } from "../src/lib/independentLanguageCouncil.ts";
import { reconcileProblemEvidence, visionEvidenceSystemPrompt, evidenceJudgeBrief, evidenceSolverBrief } from "../src/lib/problemEvidence.ts";
import { corroboratedImprovementIdeas, parseJudgeUpgradeVote, canAdoptJudgeUpgrade } from "../src/lib/judgeUpgradePolicy.ts";
import { executionId, validateExecution, e2bCommandFailure, parseExecutionOutput, executionStatus, classifyExecutionFailure, mapCandidateFailureLocation, requiresRepair, repairOutcome, withSandboxLifecycle } from "./lib/phase2Execution.mjs";
import { runGithubBenchmark } from "./lib/githubBenchmark.mjs";
import { parallelMap, workerConcurrency } from "./lib/parallelField.mjs";
import {createSandboxCapacity, hobbyWorkerLimit, standbyBudget} from "./lib/e2bCapacity.mjs";
import {createE2BWarmPool} from "./lib/e2bWarmPool.mjs";
import {selectedCppStandard} from "./lib/e2bRuntimeProfile.mjs";
import {compareDifferentialTraces} from "./lib/e2bDifferential.mjs";
import {assessHarnessTrust, buildE2BEvidenceSummary, buildAlgorithmEvidence, requireTrustedHarness} from "./lib/e2bEvidence.mjs";
import { loadLanguagePack, languagePrompt } from "./lib/languageRegistry.mjs";
import { fetchAuthoritativeLanguageContext, inferDocumentationLanguage } from "./lib/authoritativeLanguageDocs.mjs";
import { fetchExternalLanguageRows, createRegistryDirectoryLoader } from "./lib/externalLanguageSources.mjs";
import { fetchLanguageViaGateway } from "./lib/supabaseLanguageGateway.mjs";
import { referenceKey, isReferenceValidated, markReferenceValidated } from "./lib/harnessCache.mjs";
import { phaseTimer } from "./lib/phaseTimings.mjs";
import { MAX_CANDIDATE_REPAIR_ATTEMPTS } from "../src/lib/revisionPolicy.ts";
import { isVerifiedImageProbe, preferredVisionModels } from "../src/lib/visionModelPolicy.ts";
import { requiredProblemLanguage, contractSupportsEarlyHarness, isVerified, evidenceStatus, createBoundedExecutor } from "./lib/specFirstDelivery.mjs";
import { buildVerifiedSemanticBlueprint } from "./lib/verifiedSemanticBlueprint.mjs";
import { screenProvisionalCandidate, createProvisionalRecord, buildSolutionHistory } from "./lib/provisionalCouncil.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gatewayPreset } from "../src/lib/models.ts";
import { SELECTABLE_PRIMARY_MODEL_IDS, isPrimaryModel, isSelectablePrimaryModel, listedPrimaryRoute, preferredPrimaryRoute, primaryCatalog, primaryModelId } from "../src/lib/primaryModels.ts";
import { coordinateAndVerify } from "../src/lib/visionCoordinator.ts";
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
// The database is the recovery queue, not the fast path. Keep the recovery
// interval short enough that a missed external dispatch does not make a newly
// submitted job appear stalled, while avoiding an aggressive busy loop.
const POLL_MS = Number(process.env.CODE_AUDITOR_WORKER_POLL_MS || 2000);
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
  runtimeGuidance,
  revisionPolicy,
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
  import("../src/lib/languageRuntimeGuidance.ts"),
  import("../src/lib/revisionPolicy.ts"),
  import("../src/lib/mcq.ts"),
]);

const { detectMcq, parseMcqAnswer, resolveMcqSelection, formatMcqSelection } = mcq;
const { loadKnowledgeLibrary } = knowledgeLibrary;
const { runtimeGuidanceFor } = runtimeGuidance;
const { needsCandidateRevision } = revisionPolicy;

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
  MIN_INDEPENDENT_HARNESS_CASES,
  candidateDocket,
  candidateLanguage,
  countCases,
  invalidCaseTraceIds,
  councilMarkdown,
  executionDigest,
  executionFailureEvidence,
  judgeSystemPrompt,
  judgeUserPrompt,
  endpointForCouncilModel,
  enforceWinnerGate,
  harnessIsSuspect,
  letterFor,
  looksLikeCodingProblem,
  partitionByVision,
  answerStanding,
  gateFor,
  reasoningFields,
  reasoningForModel,
  rejectedImages,
  rejectedReasoning,
  parseTestSuites,
  missingSuiteLanguages,
  parseReviewSet,
  parseCouncilSynthesis,
  parseJudgeReport,
  decideWinner,
  agreedComplexityAudits,
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
  spliceSuiteWithSourceMap,
  synthesisSystemPrompt,
  synthesisUserPrompt,
  testSpecSystemPrompt,
  testSpecUserPrompt,
  harnessPreflightDiagnostics,
} = council;

const MAX_OUTPUT = 64 * 1024;
const REMOTE_RUN_TIMEOUT_MS = 120_000;
// Process-local guard includes idle prewarmed microVMs and active execution.
// A distributed quota gate is still required before multi-replica rollouts.
const E2B_CAPACITY = createSandboxCapacity(
  hobbyWorkerLimit(process.env.CODE_AUDITOR_E2B_WORKER_CAP, 8)
);
const E2B_WARM_IDLE_MS = Math.trunc(Math.max(1_000, Math.min(180_000,
  Number(process.env.CODE_AUDITOR_E2B_WARM_IDLE_MS) || 75_000
)));
const E2B_TIMEOUT_ATTEMPTS = Math.max(1, Number(process.env.CODE_AUDITOR_E2B_TIMEOUT_ATTEMPTS || 2));
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

// Fetch directory records once per TTL, shared by all languages/jobs. This
// directory is service-role-only and contains no actual programming guides.
const languageDirectory=createRegistryDirectoryLoader(()=>
  rest("external_service_registry?select=service_key,provider,project_ref,content_category,stores_language_markdown,is_external,metadata&service_key=eq.council_language_docs&limit=1")
);

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

async function nextQueuedBenchmark() {
  try {
    const rows = await rest("benchmark_requests?status=eq.queued&order=created_at.asc&limit=1");
    return rows?.[0] || null;
  } catch (err) {
    // An older database must not stop the existing Council job queue.
    if (/benchmark_requests.*(does not exist|schema cache)|PGRST205|42P01/i.test(String(err))) return null;
    throw err;
  }
}

async function runQueuedBenchmark(request) {
  const claimed = await rest(`benchmark_requests?id=eq.${request.id}&status=eq.queued`, {
    method: "PATCH", body: JSON.stringify({ status: "running" }),
  });
  if (!claimed?.length) return;
  try {
    await loadOwnerSecrets(request.owner_id);
    if (!secret("E2B_API_KEY")) throw new Error("No E2B key is saved for this account.");
    const result = await runE2BCode(request.language, request.program, request.timeout_ms, { stdin: request.stdin || "" });
    await rest(`benchmark_requests?id=eq.${request.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed", result, finished_at: new Date().toISOString() }),
    });
  } catch (err) {
    await rest(`benchmark_requests?id=eq.${request.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "failed", error: err instanceof Error ? err.message : String(err), finished_at: new Date().toISOString() }),
    });
  } finally {
    jobSecrets = null;
  }
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

const AZURE_SCREENSHOT_BUCKET = "azure:council-images";
const AZURE_CONTAINER = "council-images";
const AZURE_SAS_VERSION = "2023-11-03";

function azureCredentials() {
  const connectionString = secret("azure_storage_connection_string");
  if (!connectionString) throw new Error("No Azure Storage connection string is saved for this account.");
  const fields = new Map(connectionString.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [[part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()]] : [];
  }));
  const account = fields.get("accountname");
  const key = fields.get("accountkey");
  if (account !== "councilimages") throw new Error("Azure Storage must use the councilimages account.");
  if (!key) throw new Error("Azure Storage connection string has no AccountKey.");
  const decodedKey = Buffer.from(key, "base64");
  if (!decodedKey.length) throw new Error("Azure Storage connection string has an invalid AccountKey.");
  return { account, key: decodedKey };
}

function azureBlobPath(path) {
  if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid Azure screenshot path.");
  }
  return path.split("/").map(encodeURIComponent).join("/");
}

function azureSignedReadUrl(path, seconds = 900) {
  const { account, key } = azureCredentials();
  const safePath = azureBlobPath(path);
  const expiresAt = new Date(Date.now() + Math.min(7200, Math.max(60, seconds)) * 1000)
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  const resource = `/blob/${account}/${AZURE_CONTAINER}/${path}`;
  const stringToSign = ["r", "", expiresAt, resource, "", "", "https", AZURE_SAS_VERSION,
    "b", "", "", "", "", "", "", ""].join("\n");
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("base64");
  const url = new URL(`https://${account}.blob.core.windows.net/${AZURE_CONTAINER}/${safePath}`);
  url.searchParams.set("sp", "r");
  url.searchParams.set("se", expiresAt);
  url.searchParams.set("spr", "https");
  url.searchParams.set("sv", AZURE_SAS_VERSION);
  url.searchParams.set("sr", "b");
  url.searchParams.set("sig", signature);
  return url.toString();
}

async function downloadJobImages(jobId) {
  const rows = await listJobImages(jobId);
  // This row set is the immutable, ordered manifest created for one submission
  // by `solve_job_create`.  Resolve every signed URL before a model is asked to
  // work: every selected seat receives this same complete manifest rather than
  // discovering screenshots by session or by a mutable "latest" prefix.
  const out = await Promise.all((rows || []).map(async (row) => {
    const url = row.storage_bucket === AZURE_SCREENSHOT_BUCKET
      ? azureSignedReadUrl(row.storage_path)
      : await signedStorageUrl(row.storage_path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${row.file_name}: ${res.status} ${res.statusText}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      position: row.position,
      fileName: row.file_name,
      mime: row.mime || "image/png",
      // Give gateways the direct, blob-scoped read URL.  `dataUrl` remains a
      // verified fallback for a provider that cannot fetch a remote URL.
      url,
      dataUrl: `data:${row.mime || "image/png"};base64,${bytes.toString("base64")}`,
    };
  }));
  return out.sort((a, b) => Number(a.position) - Number(b.position));
}

function chatModels(settings) {
  const configured = Array.isArray(settings?.councilModels)
    ? settings.councilModels
    : COUNCIL_DEFAULT_MODELS;
  return canonicalCouncilSeats(configured, (m) => m?.id, "id", settings?.availableModels)
    // The Responses filter that used to live here dated from a worker that only
    // spoke chat-completions. It now speaks both, so dropping a seat the user
    // deliberately configured would be silently discarding their roster.
    .filter((model) => model?.id)
    .slice(0, Math.min(4, Math.max(1, Number(process.env.CODE_AUDITOR_WORKER_SOLVERS || 4))));
}

/**
 * The desktop's adaptive run starts with the approved ten-model pool, then a
 * coordinator which can see the actual submission assigns up to four seats.
 * Overlay jobs must use that same contract. `councilModels` is a saved Council
 * configuration (and remains useful for judges and endpoint preferences), not
 * a list of solvers to pre-assign before the problem has been read.
 */
const AGENT_FOR_PRIMARY_MODEL = Object.freeze({
  "claude-opus-5.5": "anthropic",
  "claude-fable-5.1": "fable",
  "gpt-5.6-sol": "openai",
  "gemini-3.1-pro": "gemini",
  "grok-4.6": "grok",
  "gpt-5.6-terra": "terra",
  "qwen3.8-max": "qwen",
  "kimi-k3": "moonshot",
  "glm-5.3": "glm",
  "deepseek-v4-pro-max": "deepseek",
  "seed-2.1-pro": "seed",
});

function approvedSolverPool(settings) {
  // The live gateway catalogue supplies the exact wire spelling. If it is
  // temporarily unavailable, retain the same approved identities the desktop
  // will attempt, rather than reducing the overlay to a stale saved roster.
  const listed = primaryCatalog(settings?.availableModels || []);
  const routes = listed.length
    ? listed
    : SELECTABLE_PRIMARY_MODEL_IDS.map((id) => preferredPrimaryRoute(id, gatewayId(settings)));
  const hasEnablement = settings?.enabled && typeof settings.enabled === "object";
  // Snapshots created before adaptive panels had no enablement map. Preserve
  // their explicit Council roster rather than surprising an old client by
  // widening it to ten routes. Current desktop and overlay snapshots always
  // carry `enabled`, so they take the adaptive ten-model path below.
  if (!hasEnablement) return chatModels(settings).filter(seat => isSelectablePrimaryModel(seat.id));
  const enabled = settings.enabled;
  return routes.flatMap((route) => {
    const id = primaryModelId(route);
    const agent = id ? AGENT_FOR_PRIMARY_MODEL[id] : null;
    // Missing legacy flags mean enabled, exactly as the desktop's default
    // settings do. An explicit false remains authoritative.
    return id && isSelectablePrimaryModel(route) && agent && enabled[agent] !== false ? [{ id: route }] : [];
  });
}

function hasAdaptiveSolverSelection(settings) {
  return Boolean(settings?.enabled && typeof settings.enabled === "object");
}

function chatJudges(settings) {
  const configured = Array.isArray(settings?.councilJudges)
    ? settings.councilJudges
    : COUNCIL_DEFAULT_JUDGES;
  return canonicalCouncilSeats(configured, (j) => j?.model, "model", settings?.availableModels)
    .filter((judge) => judge?.model && isSelectablePrimaryModel(judge.model))
    .slice(0, Number(process.env.CODE_AUDITOR_WORKER_JUDGES || 3));
}

/**
 * The desktop and the capture overlay must read screenshots through the same
 * configured reader seats. Solver selection is deliberately independent of
 * this: a model that is excellent at code need not be the model the owner
 * chose to transcribe pixels. When an older saved setting has no reader list,
 * retain the Council-roster fallback rather than inventing a route.
 */
function screenshotReaderSeats(settings, fallback) {
  const extractors = Array.isArray(settings?.extractors) ? settings.extractors : [];
  const routerModels = settings?.routerModels && typeof settings.routerModels === "object"
    ? settings.routerModels
    : {};
  const configured = extractors
    .map((provider) => String(routerModels[provider] || "").trim())
    .filter(Boolean)
    .map((id) => ({ id }));
  const seats = configured.length ? configured : fallback;
  return canonicalCouncilSeats(seats, (seat) => seat?.id, "id", settings?.availableModels)
    .filter(seat => isSelectablePrimaryModel(seat.id));
}

function gatewayBaseUrl(settings) {
  return settings?.gatewayBaseUrl || ({
    cleanapis: "https://cleanapis.com/v1",
    experientiallabs: "https://api.experientiallabs.ai/v1",
    wiro: "https://llm.wiro.ai/v1",
    tokenrouter: "https://api.tokenrouter.com/v1",
  })[settings?.gatewayId || "tokenrouter"] || "https://api.tokenrouter.com/v1";
}

function gatewayId(settings) {
  const baseUrl = String(settings?.gatewayBaseUrl || "");
  if (settings?.gatewayId === "cleanapis" || baseUrl.includes("cleanapis.com")) return "cleanapis";
  if (settings?.gatewayId === "experientiallabs" || baseUrl.includes("experientiallabs.ai")) return "experientiallabs";
  if (settings?.gatewayId === "wiro" || baseUrl.includes("llm.wiro.ai")) return "wiro";
  return "tokenrouter";
}

/** Gateways that serve unprefixed ids and the OpenAI-compatible JSON mode. */
function usesDirectGateway(settings) {
  const id = gatewayId(settings);
  return id === "cleanapis" || id === "experientiallabs";
}

/** Trusty rides the selected gateway, falling back to Clean API on TokenRouter. */
function trustyGateway(settings) {
  const id = gatewayId(settings);
  return id === "tokenrouter" ? "cleanapis" : id;
}

function gatewayCredential(settings) {
  const id = gatewayId(settings);
  return secret(id) || secret(`${id.toUpperCase()}_API_KEY`) ||
    (id === "tokenrouter" ? secret("TOKENROUTER_API_KEY") : "");
}

/**
 * Settings use provider-qualified ids (for example `openai/gpt-5.6-sol`),
 * while gateway catalogues often return only a wire id (`gpt-5.6-sol`).
 * Resolve either spelling, then use the catalogue spelling for the request.
 */
function canonicalCouncilSeats(seats, idOf, key, catalogue) {
  if (!Array.isArray(catalogue) || !catalogue.length) return seats;
  return seats.flatMap((seat) => {
    const configured = String(idOf(seat) || "").trim();
    // Resolve aliases by approved model identity and return the gateway's
    // exact current spelling. This handles bare Clean APIs ids, qualified
    // TokenRouter ids, and documented aliases without manual migrations.
    const resolved = listedPrimaryRoute(configured, catalogue) || "";
    return resolved ? [{ ...seat, [key]: resolved }] : [];
  });
}

function unreachableCouncilSeatIds(seats, idOf, catalogue) {
  if (!Array.isArray(catalogue) || !catalogue.length) return [];
  return seats
    .map(idOf)
    .map((id) => String(id || "").trim())
    .filter((id) => !listedPrimaryRoute(id, catalogue));
}

function gatewayModel(model, settings) {
  const approved = primaryModelId(model);
  if (!approved) throw new Error(`${model} is outside the approved ten-model roster.`);
  const gateway = gatewayId(settings);
  // Experiential publishes the granted routes under different spellings; the
  // catalogue also lists the locked canonical ones, so the alias must win.
  if (gateway === "experientiallabs") return preferredPrimaryRoute(approved, gateway);
  return listedPrimaryRoute(model, settings?.availableModels ?? []) ||
    preferredPrimaryRoute(approved, gateway);
}

async function discoverWorkerCatalog(settings) {
  // A saved list may belong to the gateway selected before this job. Never use
  // it as evidence about the current credential.
  settings.availableModels = [];
  try {
    const response = await fetch(`${gatewayBaseUrl(settings).replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${gatewayCredential(settings)}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;
    const body = await response.json();
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    settings.availableModels = primaryCatalog(rows.map(row => typeof row === "string" ? row : row?.id).filter(Boolean));
  } catch {
    // An unavailable catalogue is unknown, not permission to use other models.
  }
}

function retryDelayMs(status, text, attempt, retryAfter) {
  // A 524 is emitted by an upstream Cloudflare edge after its origin model
  // did not finish in that edge's window.  Waiting in the desktop app cannot
  // revive that closed request; retrying the same job-bound request can.  Keep
  // this short and bounded so one slow route does not hold the Council hostage.
  if (status === 524) return Math.min(1_500 * (attempt + 1), 6_000);
  if (status !== 429) return 0;
  const seconds = retryAfter == null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 90_000);
  const minuteLimit = /within\s+1\s+minutes?/i.test(text);
  const explicit = /retry(?:\s|-)?after["':\s]+(\d+)/i.exec(text);
  if (explicit) return Math.min(Number(explicit[1]) * 1000, 90_000);
  return minuteLimit ? 65_000 : Math.min(10_000 * 2 ** attempt, 60_000);
}

function gatewayFailureSummary(model, status, body) {
  const raw = String(body || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (Number(status) === 524) {
    return `${model}: upstream model timed out (524)`;
  }
  if (!raw) return `${model}: gateway request failed (${status || "unknown status"})`;
  return `${model}: gateway request failed (${status || "unknown status"}) — ${raw.slice(0, 180)}`;
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

function largerOutputBudget(current, ceiling = 64_000) {
  const requested = Math.max(Number(current) + 1_024, Math.ceil(Number(current) * 1.5));
  return Math.min(ceiling, requested);
}

function responseWasTruncated(json) {
  return json?.status === "incomplete" &&
    /max_output_tokens|output_tokens/i.test(String(json?.incomplete_details?.reason || ""));
}

async function tokenRouterChat({ baseUrl, model, system, user, images = [], maxTokens = 4096, reasoning = "off", apiKey, paced = true, responseFormat }) {
  // Historical in-flight GLM calls may finish and be recorded; fresh solver
  // selection already excludes GLM in approvedSolverPool.
  if (!isPrimaryModel(model)) throw new Error(`${model} is outside the known model roster.`);
  const content = [{ type: "text", text: user }];
  for (const image of images) {
    content.push({ type: "image_url", image_url: { url: baseUrl.includes("experientiallabs.ai") ? image.dataUrl : (image.url || image.dataUrl) } });
  }

  let temperature = 0.2;
  let last = "";
  let timeouts = 0;
  let think = noReasoning.has(model) ? "off" : reasoning;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (paced) await tokenRouterTurn();
    const controller = new AbortController();
    const budget = thinkingBudget(think);
    const timeout = setTimeout(() => controller.abort(), budget);
    let resp;
    try {
      resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
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
          ...(responseFormat ? { response_format: responseFormat } : {}),
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
    last = gatewayFailureSummary(model, resp.status, text);
    if (resp.ok) {
      let answer = "";
      let completion = null;
      try {
        completion = JSON.parse(text);
        answer = chatCompletionText(completion);
      } catch {
        throw new Error(`${model}: gateway returned malformed JSON`);
      }
      const finishReason = completion?.choices?.[0]?.finish_reason;
      const completionTokens = completion?.usage?.completion_tokens;
      const truncated = finishReason === "length";
      if (answer.trim()) {
        if (truncated) {
          last = `${model}: response truncated at output limit (finish_reason=length${Number.isFinite(completionTokens) ? `, completion_tokens=${completionTokens}` : ""})`;
          const nextBudget = largerOutputBudget(maxTokens);
          if (attempt < 2 && nextBudget > maxTokens) {
            // A 200 response is not complete merely because it has some text.
            // Retry only truncation, preserving the same model and prompt.
            maxTokens = nextBudget;
            await sleep(250 * (attempt + 1));
            continue;
          }
          throw new Error(last);
        }
        return answer;
      }

      // Some OpenAI-compatible routes acknowledge a reasoning request with a
      // 200 but omit `message.content`.  That is neither a candidate answer
      // nor evidence that the model cannot write a harness. Retry the same
      // request without reasoning once, then give the route its remaining
      // bounded retry.  This is especially important for the spec phase: a
      // single empty completion must not turn an otherwise solved problem into
      // an E2B failure.
      last = `${model}: empty model response${finishReason ? ` (finish_reason=${finishReason})` : ""}${Number.isFinite(completionTokens) ? ` (completion_tokens=${completionTokens})` : ""}`;
      if (truncated) {
        if (think !== "off") think = "off";
        const nextBudget = largerOutputBudget(maxTokens);
        if (attempt < 2 && nextBudget > maxTokens) {
          // Some gateways spend the completion allowance on hidden reasoning
          // and return no visible text with finish_reason=length. Retrying at
          // the same cap cannot recover the required answer.
          maxTokens = nextBudget;
          await sleep(250 * (attempt + 1));
          continue;
        }
      }
      if (think !== "off") {
        // An empty completion is transient and does not prove that this model
        // rejects reasoning. Drop it only for the remaining attempts in this
        // request; explicit provider rejection below is the only global hint.
        think = "off";
      }
      if (attempt < 2) {
        await sleep(250 * (attempt + 1));
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

    // Retry an upstream 524.  It represents an interrupted provider request,
    // not a model answer or a bad harness.  After the first 524, reduce hidden
    // reasoning only for this one request so the provider has room to return
    // the required code/text before its own edge deadline.
    if (resp.status === 524 && attempt < 2) {
      if (think !== "off" && attempt > 0) think = "off";
      await sleep(retryDelayMs(resp.status, text, attempt, resp.headers.get("retry-after")));
      continue;
    }
    const waitMs = retryDelayMs(resp.status, text, attempt, resp.headers.get("retry-after"));
    if (!waitMs || attempt === 2) break;
    await sleep(waitMs);
  }
  throw new Error(`${model}: ${last}`);
}

/**
 * OpenAI-compatible gateways do not all serialize a completion identically.
 * Accept the documented string form and the content-part form used by newer
 * compatible routes, while deliberately ignoring reasoning-only fields.
 */
function chatCompletionText(json) {
  const choice = json?.choices?.[0] || {};
  const content = choice?.message?.content ?? choice?.text ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (typeof part?.text === "string") return part.text;
    if (typeof part?.content === "string") return part.content;
    return "";
  }).join("");
}

async function tokenRouterResponses({ baseUrl, model, system, user, images = [], maxTokens = 4096, reasoning = "off", apiKey, paced = true }) {
  if (!isPrimaryModel(model)) throw new Error(`${model} is outside the known model roster.`);
  const content = [{ type: "input_text", text: user }];
  for (const image of images) {
    content.push({ type: "input_image", image_url: baseUrl.includes("experientiallabs.ai") ? image.dataUrl : (image.url || image.dataUrl) });
  }

  let last = "";
  let timeouts = 0;
  let think = noReasoning.has(model) ? "off" : reasoning;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (paced) await tokenRouterTurn();
    const controller = new AbortController();
    const budget = thinkingBudget(think);
    const timeout = setTimeout(() => controller.abort(), budget);
    let resp;
    try {
      resp = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
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
    last = gatewayFailureSummary(model, resp.status, text);
    if (resp.ok) {
      let answer = "";
      let completion = null;
      try {
        completion = JSON.parse(text);
        answer = responseText(completion);
      } catch {
        throw new Error(`${model}: gateway returned malformed JSON`);
      }
      const truncated = responseWasTruncated(completion);
      const completionTokens = completion?.usage?.output_tokens ?? completion?.usage?.completion_tokens;
      if (answer.trim()) {
        if (!truncated) return answer;
        last = `${model}: response truncated at output limit${Number.isFinite(completionTokens) ? ` (completion_tokens=${completionTokens})` : ""}`;
        const nextBudget = largerOutputBudget(maxTokens);
        if (attempt < 2 && nextBudget > maxTokens) {
          maxTokens = nextBudget;
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw new Error(last);
      }

      // Match the Chat Completions recovery path.  A few compatible Responses
      // routes return a successful reasoning-only envelope with no final text.
      // That is not a usable harness (or answer), but it also is not evidence
      // that the model is unavailable.  Retry once without the reasoning field
      // before giving the route its remaining bounded attempt.
      last = `${model}: empty model response${truncated ? " (output limit reached)" : ""}${Number.isFinite(completionTokens) ? ` (completion_tokens=${completionTokens})` : ""}`;
      if (truncated) {
        if (think !== "off") think = "off";
        const nextBudget = largerOutputBudget(maxTokens);
        if (attempt < 2 && nextBudget > maxTokens) {
          maxTokens = nextBudget;
          await sleep(250 * (attempt + 1));
          continue;
        }
      }
      if (think !== "off") {
        // Do not poison future questions based on one empty completion.
        think = "off";
      }
      if (attempt < 2) {
        await sleep(250 * (attempt + 1));
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

    if (resp.status === 524 && attempt < 2) {
      if (think !== "off" && attempt > 0) think = "off";
      await sleep(retryDelayMs(resp.status, text, attempt, resp.headers.get("retry-after")));
      continue;
    }

    const waitMs = retryDelayMs(resp.status, text, attempt, resp.headers.get("retry-after"));
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
  const endpoint = gatewayId(settings) === "tokenrouter"
    ? endpointForCouncilModel(settings?.councilModels, args.model) : "chat";
  // Decided here rather than at six call sites, so no phase can quietly forget
  // to ask a model to think.
  // Reading and contract extraction are structured, bounded tasks. Giving them
  // the full solve-time reasoning budget made every run wait behind two sets of
  // expensive deliberation before a single solver was even assigned. Callers
  // can explicitly keep those preflight requests concise; actual solutions
  // still use the user's configured reasoning effort.
  const reasoning = args.reasoning ?? reasoningForModel(settings, args.model);
  const withThinking = { ...args, model: gatewayModel(args.model, settings),
    apiKey: gatewayCredential(settings), paced: !usesDirectGateway(settings), reasoning };
  if (!usesDirectGateway(settings)) delete withThinking.responseFormat;
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
  return /insufficient_user_quota|credit limit is insufficient|account quota is running low|please recharge|billing verification failed|payment method/i.test(
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


function shellSingle(s) {
  return `'${String(s).replaceAll("'", `'"'"'`)}'`;
}

export function remoteScript(language, code, providerLabel = "remote", stdin = "") {
  const encoded = Buffer.from(code, "utf8").toString("base64");
  const encodedStdin = Buffer.from(stdin, "utf8").toString("base64");
  return `set -u
tmp="$(mktemp -d "\${TMPDIR:-/tmp}/council-editor-bench.XXXXXX")" || exit 98
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
cd "$tmp" || exit 98
# Restrict generated processes even inside the E2B microVM. E2B enforces
# the outer wall-clock deadline, and the workspace is disposable.
ulimit -f 32768 || exit 98
ulimit -v 2097152 || exit 98
ulimit -t 120 || exit 98
cat > code.b64 <<'CA_CODE'
${encoded}
CA_CODE
base64 -d code.b64 > code.txt
cat > stdin.b64 <<'CA_STDIN'
${encodedStdin}
CA_STDIN
base64 -d stdin.b64 > stdin.txt
lang=${shellSingle(language)}
lang="$(printf '%s' "$lang" | tr '[:upper:]' '[:lower:]' | tr -d ' _-')"
# Fourth and last copy of the language table. Same standard-stripping as the
# local table and the Actions workflow,
# so a c++17 fence compiles here too instead of exiting 97 unrun.
case "$lang" in
  c++*|cpp*|cxx*) lang=cpp ;;
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
  cpp|c++|cc|cxx) file=main.cpp; cp code.txt "$file"; command='c++ -std=${selectedCppStandard(process.env.CODE_AUDITOR_CPP_STANDARD)} -O2 main.cpp -o prog && if [ -x /usr/bin/time ]; then /usr/bin/time -f "CA_PROGRAM_METRICS elapsed_s=%e maxrss_kb=%M" ./prog; else ./prog; fi'; runtime='${providerLabel} c++ -O2' ;;
  java) file=Main.java; cp code.txt "$file"; command='javac Main.java && java Main'; runtime='${providerLabel} javac + java' ;;
  go|golang) file=main.go; cp code.txt "$file"; command='go run main.go'; runtime='${providerLabel} go' ;;
  rust|rs) file=main.rs; cp code.txt "$file"; command='rustc -O main.rs -o prog 2>&1 && if [ -x /usr/bin/time ]; then /usr/bin/time -f "CA_PROGRAM_METRICS elapsed_s=%e maxrss_kb=%M" ./prog; else ./prog; fi'; runtime='${providerLabel} rustc -O' ;;
  *) echo "Unsupported remote benchmark language: $lang" >&2; exit 97 ;;
esac
printf 'CA_E2B_EXECUTION_STARTED\\n'
status=0
if command -v /usr/bin/time >/dev/null 2>&1; then
  /usr/bin/time -o time.txt -f 'CA_METRICS elapsed_s=%e maxrss_kb=%M' bash -lc "$command" <stdin.txt > >(tee >(head -c 65536 > stdout.txt) >/dev/null) 2> >(tee >(head -c 65536 > stderr.txt) >/dev/null) || status=$?
  wait
  cat time.txt >>stderr.txt 2>/dev/null || true
else
  start="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  bash -lc "$command" <stdin.txt > >(tee >(head -c 65536 > stdout.txt) >/dev/null) 2> >(tee >(head -c 65536 > stderr.txt) >/dev/null) || status=$?
  wait
  finish="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  printf 'CA_METRICS elapsed_ms=%s maxrss_kb=\\n' "$((finish - start))" >>stderr.txt
fi
printf 'CA_STDOUT_BEGIN\\n'
head -c 65536 stdout.txt 2>/dev/null || true
printf '\\nCA_STDOUT_END\\nCA_STDERR_BEGIN\\n'
head -c 65536 stderr.txt 2>/dev/null || true
printf '\\nCA_STDERR_END\\nCA_EXIT:%s\\nCA_RUNTIME:%s\\n' "$status" "$runtime"
exit "$status"
`;
}

/** E2B is the sole execution and measurement backend. */
export function resolveBenchmarkBackend() {
  return "off";
}

/** The repo Actions dispatches against. */
export function repoFor(env = process.env) {
  return String(env.GITHUB_REPOSITORY || env.CODE_AUDITOR_GITHUB_REPOSITORY || "").trim();
}

/** E2B microVMs share the same isolated template, not filesystem state.
 * Capacity permits are held for the FULL lifetime (including standby).
 */
async function createE2BLease({executionId, timeoutMs, purpose="benchmark", slot="", jobId=""}) {
  const release = await E2B_CAPACITY.acquire();
  try {
    const { Sandbox } = await import("@e2b/code-interpreter");
    const bootStarted = Date.now();
    const template = String(process.env.CODE_AUDITOR_E2B_TEMPLATE || "").trim();
    const opts = {
      apiKey: secret("E2B_API_KEY"),
      timeoutMs,
      allowInternetAccess: false,
      metadata: {
        executionId, app: "code-editor", workerId: WORKER_ID, purpose,
        ...(slot ? {solverSeat:slot} : {}),
        ...(jobId ? {jobId} : {}),
        template: template || "code-interpreter-v1",
      },
    };
    const sandbox = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
    return {sandbox, release, bootMs: Date.now() - bootStarted};
  } catch (error) {
    release();
    throw error;
  }
}

async function runE2BCode(language, code, timeoutMs = REMOTE_RUN_TIMEOUT_MS, options = {}) {
  const policy = validateExecution(language, code, timeoutMs);
  const id = options.executionId || executionId();
  const started = Date.now();
  // Solver A/B/C/D may already own a separate E2B microVM from the
  // same immutable template. Consume it only once; other passes are cold.
  const standby = options.warmPool && options.candidateLetter
    ? await options.warmPool.take(options.candidateLetter) : null;
  const lease = standby || await createE2BLease({
    executionId: id, timeoutMs: Math.max(policy.timeoutMs + 30_000, 90_000)
  });
  const {sandbox, bootMs} = lease;
  try {
  return await withSandboxLifecycle(sandbox,
    () => options.onState?.("running", { executionId: id, sandboxId: sandbox.sandboxId, bootMs }),
    async () => {
    let result;
    try {
      result = await sandbox.commands.run(`bash -lc ${shellSingle(remoteScript(language, code, "e2b", options.stdin || ""))}`, {
        timeoutMs: policy.timeoutMs,
        onStdout: (data) => {
          try { options.onOutput?.("stdout", String(data)); } catch { /* progress hooks must not interrupt execution */ }
        },
        onStderr: (data) => {
          try { options.onOutput?.("stderr", String(data)); } catch { /* progress hooks must not interrupt execution */ }
        },
      });
    } catch (err) {
      result = e2bCommandFailure(err);
      if (!result) throw err;
    }
    const parsed = parseExecutionOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
    const exitCode = parsed.complete && (result.exitCode == null || result.exitCode === parsed.exitCode)
      ? parsed.exitCode : null;
    const out = clampOutput(parsed.complete ? parsed.stdout : result.stdout || "");
    const err = clampOutput(parsed.complete ? parsed.stderr : result.stderr || "");
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
      totalElapsedMs: parsed.totalElapsedMs,
      totalPeakMemoryKb: parsed.totalPeakMemoryKb,
      timedOut: false,
      truncated: out.truncated || err.truncated,
      executionId: id,
      state: exitCode === 0 ? "completed" : "failed",
      exitVerified: parsed.complete,
      network: "denied",
      provider: "e2b",
      sandboxId: sandbox.sandboxId,
      bootMs,
      prewarmed: Boolean(standby),
      warmIdleMs: standby?.warmIdleMs ?? null,
    };
    },
    async (error) => {
      const state = /timed out|timeout/i.test(String(error)) ? "timed_out" : "failed";
      await options.onState?.(state, { executionId: id, sandboxId: sandbox.sandboxId, reason: String(error).slice(0, 200) });
    }
  );
  } finally {
    // The sandbox lifecycle has already called kill(), including on failure.
    lease.release();
  }
}

function executionProvider(settings) {
  // Legacy saved settings may still say local. Fail closed to E2B only.
  const selected = String(
    settings.executionProvider ||
      process.env.CODE_AUDITOR_EXECUTION_PROVIDER ||
      "e2b"
  ).trim().toLowerCase();
  if (selected !== "e2b" && selected !== "local") {
    throw new Error(`Unsupported execution provider: ${selected}`);
  }
  return "e2b";
}

async function runVerification(settings, suite, program, options = {}) {
  const provider = executionProvider(settings);
  if (process.env.NODE_ENV === "test" && typeof globalThis.__COUNCIL_E2B_TEST_DOUBLE__ === "function") {
    return globalThis.__COUNCIL_E2B_TEST_DOUBLE__(suite.runnerLanguage || suite.language, program, options);
  }
  if (provider !== "e2b" || !secret("E2B_API_KEY")) {
    throw new Error("No E2B key is saved for the account that owns this job.");
  }
  const timeoutMs = Number(settings.e2bTimeoutMs || REMOTE_RUN_TIMEOUT_MS);
  let last;
  for (let attempt = 1; attempt <= E2B_TIMEOUT_ATTEMPTS; attempt += 1) {
    try {
      const result = await runE2BCode(suite.runnerLanguage || suite.language, program, timeoutMs,
        attempt === 1 ? options : {...options, warmPool: null});
      if (!result.timedOut || attempt === E2B_TIMEOUT_ATTEMPTS) return result;
      last = new Error(`E2B execution timed out (attempt ${attempt})`);
    } catch (error) {
      if (!/timed out|timeout|deadline_exceeded|unavailable/i.test(String(error)) || attempt === E2B_TIMEOUT_ATTEMPTS) throw error;
      last = error;
    }
  }
  throw last || new Error("E2B execution timed out");
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
  const selected = candidates.filter(candidate => !revised || candidate.revised);
  const limit = workerConcurrency(process.env.CODE_AUDITOR_E2B_CONCURRENCY, 4, 9);
  const startedAt = Date.now();
  await parallelMap(selected, limit, async (candidate) => {
    const final = revised ? (candidate.revised ?? null) : candidate.final;
    const lang = final?.kind === "code" ? candidateLanguage(final) : "";
    const code = final?.code || "";
    const baseSuite = suites.find((s) => s.language === lang);
    // The deterministic suite carries authoritative fixtures, but callable
    // adapters must be bound to this candidate's own function/method name.
    const suite = baseSuite?.source === "provided" && baseSuite.question
      ? buildProvidedHarness(baseSuite.question, lang, code)
      : baseSuite;
    if (!final || final.kind !== "code" || !code.trim()) {
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: final?.kind === "research" ? "research answer" : "no code", runtime: "" };
      return;
    }
    if (!suite) {
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: `no suite for ${lang || "unknown language"}`, runtime: "" };
      return;
    }
    const spliced = spliceSuiteWithSourceMap(suite, code);
    if (!spliced) {
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: "harness has no splice marker", runtime: "" };
      return;
    }
    const { program, sourceMap } = spliced;
    const id = executionId();
    let outputStatusSent = false;
    await addEvent(job.id, "info", "execution_queued",
      `Candidate ${candidate.letter}${tag} queued for execution.`,
      { executionId: id, state: "queued", letter: candidate.letter });
    try {
      const local = await runVerification(settings, suite, program, {
        executionId: id,
        warmPool: !revised && (opts.warmSeat || lang === "python") ? opts.warmPool : null,
        candidateLetter: opts.warmSeat || candidate.letter,
        onState: (state, meta) => addEvent(job.id, "info", "execution_state",
          `Candidate ${candidate.letter}${tag}: ${state}.`,
          { ...meta, letter: candidate.letter, state }).catch(() => {}),
        // Runner output stays private evidence. The desktop only receives a
        // generic status signal that the sandbox is making progress.
        onOutput: () => {
          if (outputStatusSent) return;
          outputStatusSent = true;
          void addEvent(job.id, "info", "execution_progress",
            `Candidate ${candidate.letter}${tag}: E2B is running its test harness.`,
            { executionId: id, letter: candidate.letter, state: "running" }).catch(() => {});
        },
      });
      const localCases = suite.source === "provided"
        ? providedCaseEvidence(local.stdout, requiredHarnessCases(suite)) : countCases(local.stdout);
      let remote;
      const backend = resolveBenchmarkBackend(settings);
      // Only a candidate that already passed locally is worth a remote machine.
      // Benchmarking something that fails its own tests measures how fast it is
      // wrong, and spends a runner minute to find that out.
      const worthBenchmarking = suite.source !== "provided" && local.ok && localCases.failed === 0 &&
        localCases.passed >= requiredHarnessCases(suite);

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
      const fullDiagnostic = String(local.stderr || "").trim().slice(0, 3000);
      const diagnostic = fullDiagnostic.split("\n").slice(0, 6).join("\n");
      const exercisedCases = localCases.passed + localCases.failed;
      const untracedPythonCases = suite.language === "python" ? invalidCaseTraceIds(local.stdout) : [];
      const insufficientCoverage = exercisedCases < requiredHarnessCases(suite) ||
        (suite.source === "provided" && !localCases.complete) || untracedPythonCases.length > 0;
      // A program that never started did not fail its tests — the harness did.
      // Naming it distinctly keeps a build problem out of the evidence the
      // judges weigh, where it would read as "this candidate is wrong".
      const brokenHarness = harnessPreflightDiagnostics(suite.language,suite.harness).length>0;
      const failureKind = insufficientCoverage ? "harness" : classifyExecutionFailure({
        run: { ...local, ran: true, ok: local.ok && !insufficientCoverage, passed: localCases.passed, failed: localCases.failed },
        sourceMap,
        harnessPreflightFailed: brokenHarness,
      });
      const failureLocation = mapCandidateFailureLocation(local.stderr, sourceMap);
      const compileIssue = /could not find or load main class|cannot find symbol|no such file or directory|command not found|compilation failed|error: expected|traceback \(most recent call last\)|nameerror:|syntaxerror:|typeerror:/i.test(diagnostic);
      runs[candidate.letter] = {
        letter: candidate.letter,
        codeDigest: createHash("sha256").update(code).digest("hex"),
        evidenceSource: suite.source || "generated",
        providedCaseCount: suite.source === "provided" ? suite.providedCaseCount : 0,
        ran: true,
        ok: local.ok && !insufficientCoverage,
        passed: localCases.passed,
        failed: localCases.failed,
        durationMs: local.durationMs,
        note: local.timedOut
          ? "timed out"
          : local.exitVerified === false
            ? "E2B command ended before the benchmark trailer; runner evidence is incomplete"
          : insufficientCoverage
            ? untracedPythonCases.length
              ? `Python harness omitted executed input/output traces for ${untracedPythonCases.length} test case(s)`
              : `test harness exercised only ${exercisedCases} distinct cases; ${requiredHarnessCases(suite)} are required`
          : brokenHarness
            ? "generated harness failed static preflight"
            : compileIssue ? "candidate/harness integration or compilation failed; inspect stderr"
            : local.exitCode !== 0
              ? `exit ${local.exitCode}`
              : "",
        runtime: local.runtime,
        // Whatever ran it measured it. These come back from the same metrics
        // script the remote runners use, and dropping them was the reason a
        // second run on Actions looked necessary at all.
        remoteElapsedMs: local.remoteElapsedMs ?? null,
        peakMemoryKb: local.peakMemoryKb ?? null,
        totalElapsedMs: local.totalElapsedMs ?? null,
        totalPeakMemoryKb: local.totalPeakMemoryKb ?? null,
        provider: local.provider || executionProvider(settings),
        executionId: local.executionId || id,
        sandboxId: local.sandboxId || null,
        state: executionStatus(local),
        exitCode: local.exitCode ?? null,
        failureKind,
        failureLocation,
        exitVerified: local.exitVerified !== false,
        timedOut: Boolean(local.timedOut),
        truncated: Boolean(local.truncated),
        bootMs: local.bootMs ?? null,
        prewarmed: Boolean(local.prewarmed),
        warmIdleMs: local.warmIdleMs ?? null,
        network: local.network || "unknown",
        stderr: fullDiagnostic,
        // Keep the bounded runner-output budget for structured CA_CASE rows;
        // truncating at 4 KiB could discard later question examples after the
        // harness had already verified them.
        stdout: String(local.stdout || "").slice(0, MAX_OUTPUT),
        remote,
      };
      await addEvent(job.id, local.ok && localCases.failed === 0 ? "info" : "warn", "benchmark_done",
        local.ok && localCases.failed === 0 && !insufficientCoverage
          ? `Candidate ${candidate.letter}${tag} passed its E2B test run.`
          : `Candidate ${candidate.letter}${tag} needs another verification pass.`,
        runs[candidate.letter]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runs[candidate.letter] = { letter: candidate.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: message, runtime: "" };
      await addEvent(job.id, "warn", "benchmark_failed", `Candidate ${candidate.letter}${tag} could not complete verification; Council is checking the run.`, runs[candidate.letter]);
    }
  });
  const elapsedMs = Date.now() - startedAt;
  await addEvent(job.id, "info", "execution_field_timing",
    `Completed ${selected.length} ${revised ? "revised" : "original"} candidate execution(s) in ${elapsedMs}ms (concurrency limit ${limit}).`,
    { elapsedMs, candidates: selected.length, concurrency: limit, revised });
  // Preserve original candidate letter order despite out-of-order completions.
  return Object.fromEntries(selected.filter(c => Object.hasOwn(runs, c.letter))
    .map(c => [c.letter, runs[c.letter]]));
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

async function prepareProblemHarnesses(job, settings, baseUrl, models, judges, question, candidates, languages, knowledge, bench) {
  if(!languages.length)return [];
  await addEvent(job.id,"info","harness_preparing","Preparing specification-derived E2B tests for "+languages.join(", "),{languages});
  // A successfully selected solver has just demonstrated that its route can
  // return a structured answer for this exact screenshot.  Prefer those seats
  // for the harness pass over an arbitrary, configured roster order.  This is
  // the same selected-agent contract used by the desktop path and prevents an
  // otherwise healthy overlay run being blocked by a cold unrelated route.
  const candidateAuthors = candidates
    .filter((candidate) => candidate?.final?.kind === "code" && candidate.final.code?.trim())
    .map((candidate) => candidate.model);
  const specModels = [...new Set([
    ...candidateAuthors, settings.synthesisModel, ...judges.map(judge => judge.model), ...models.map(model => model.id),
  ].filter(Boolean))];
  const specStartedAt = Date.now();
  const failures = new Map();
  // Database packs are checksum validated; verified bundled packs remain an offline fallback.
  // Previously all database language packs finished before any HTML lookups
  // could start, even though both sources are independent read-only inputs.
  // Fetch both groups concurrently, preserving their original language order.
  const [languagePacks, languageDocs] = await Promise.all([
    Promise.all(languages.map(language => loadLanguagePack(language, {
      // The Supabase RPC queries an external Neon foreign table; it never
      // stores Markdown in Supabase. Neon Data API currently requires JWT
      // even for anonymous readers, so prefer the authenticated FDW path.
      // If the user mapping is not configured, keep the trusted bundled fallback.
      fetchRows: id => fetchLanguageViaGateway(id,{
        queryGateway: language => rest("rpc/fetch_council_language_pack",{
          method:"POST",body:JSON.stringify({p_language:language}),
        }),
        fallback: language => fetchExternalLanguageRows(language,{
          registryDirectory:languageDirectory,
        }),
      }),
    }))),
    Promise.all(languages.map(language => fetchAuthoritativeLanguageContext(
      [question, candidateDocket(candidates).slice(0,3000)].join("\n"),
      {language}
    ))),
  ]);
  const packsByLanguage = new Map(languagePacks.map(pack => [pack.language,pack]));
  await addEvent(job.id,"info","language_packs_ready",
    `Loaded ${languagePacks.length} language-specific guides.`,
    {languages:languagePacks.map(pack=>({language:pack.language,source:pack.source,database:pack.databaseId??null,checksum:pack.checksum.slice(0,12)}))});
  // Independent languages run concurrently; within-language retry remains bounded and serial.
  const suitesByLanguage = await parallelMap(languages,
    workerConcurrency(process.env.CODE_AUDITOR_HARNESS_CONCURRENCY, 3, 4),
    async (language) => {
    const pack = packsByLanguage.get(language);
    // The owner's HTML documentation is consulted FIRST for each target
    // language, including reference-harness generation. The verified rules
    // pack still supplies runtime contracts and fallback guidance.
    const docs = languageDocs[languages.indexOf(language)];
    if(docs.prompt)await addEvent(job.id,"info","language_reference_harness",
      "Consulted the personal documentation server for "+language+" harness generation.",
      {language,source:docs.source,pages:docs.pages.map(page=>page.url)});
    let lastError = "";
    // The model gets the contract for this language only. Giving it every
    // language's syntax rules is noise and was one source of cross-language
    // harness mistakes; runtime execution below remains the final check.
    // Harness writers need the problem contract, candidate signatures and a
    // few language constraints — not an entire documentation chapter plus
    // every retrieved note.  Oversized spec prompts are the pattern behind
    // several gateway 200/empty responses, despite the same route succeeding
    // for the shorter solver request. Keep the most relevant material while
    // bounding the request well below the smallest supported context window.
    // The original supplied cases take precedence over generated tests.
    // A deterministic adapter avoids calling another model to write runnable
    // harness code for well-defined Python callables and stdin programs.
    const candidateSource = candidates.find(candidate =>
      candidate?.final?.kind === "code" && candidateLanguage(candidate.final) === language &&
      candidate.final.code?.trim())?.final?.code || "";
    const provided = buildProvidedHarness(question, language, candidateSource);
    if (provided) {
      await addEvent(job.id, "info", "provided_harness_ready",
        `${language}: compiled ${provided.providedCaseCount} question-supplied test case(s) without model-generated harness source.`,
        {language, cases: provided.providedCaseCount, source: "provided", runner: "e2b"});
      return provided;
    }
    const suppliedCases = extractProvidedFixtures(question);
    const languageKnowledge = [
      suppliedCases.length ? `QUESTION-SUPPLIED TEST CASES: ${JSON.stringify(suppliedCases).slice(0, 2500)}. Test every supplied case first; optional extra edge cases must have independently established expected outputs.` : "",
      docs.prompt.slice(0, 1_800),
      String(knowledge || settings.knowledgeDigest || "").slice(0, 1_800),
      runtimeGuidanceFor(language).slice(0, 1_400),
      languagePrompt(pack, 1_800),
    ].filter(Boolean).join("\n\n");
    // Try the complete ready solver cohort before Council can fail harness
    // setup. A solver returning no text for this separate spec request does
    // not invalidate its already-recorded solution answer.
    const harnessAuthors = specModels.filter(candidate => !bench.has(candidate));
    const maxHarnessAuthors = Math.min(harnessAuthors.length,
      Math.max(6, candidateAuthors.length + 2));
    for (const model of harnessAuthors.slice(0, maxHarnessAuthors)) {
      try {
        const structuredPython = language === "python";
        const specText = await tokenRouterGenerate({
          settings, baseUrl, model, system: structuredPython ? pythonHarnessJsonSystemPrompt() : testSpecSystemPrompt() +
             (process.env.CODE_AUDITOR_E2B_DIFFERENTIAL === "1"
               ? "\\nOPTIONAL TRACE: For up to eight deterministic, JSON-compatible test inputs," +
                 " print CA_DIFF_CASE followed by a space and a JSON object with fields id, input, actual." +
                 " These must be the actual candidate outputs; retain all required PASS/FAIL assertions." +
                 " Use stable case IDs and fixtures from the problem; omit non-JSON or multi-answer cases." : ""),
          user: testSpecUserPrompt({
            question: String(question || "").slice(0, 8_000),
            docket: (candidateDocket(candidates) || "No candidate code exists yet. Derive the test cases, outputs and API signature only from the problem specification.").slice(0, 7_000),
            languages: [language],
            knowledge: [
              languageKnowledge,
              lastError ? `THE PRIOR HARNESS WAS REJECTED: ${lastError.slice(0, 650)}. Repair only the harness.` : "",
            ].filter(Boolean).join("\n\n"),
          }),
          // Reserve a practical output budget for the runnable suite and its
          // independent reference. This auxiliary artifact is not a solver
          // answer, so it must not inherit a smaller user solve-token limit.
          maxTokens: Math.max(8_192, Number(settings.maxTokens || 4096)),
          // Harnesses are deterministic formatting/contract work, not another
          // solve pass. Keep hidden reasoning out of this output budget so a
          // reasoning-only completion cannot starve the required TESTS block.
          // The actual solver and judge calls keep the user's configured effort.
          reasoning: "off",
          ...(structuredPython ? { responseFormat: { type: "json_object" } } : {}),
        });
        const suite = structuredPython
          ? buildGeneratedPythonHarness(question, specText, candidateSource) || parseTestSuites(specText).find(item => item.language === language)
          : parseTestSuites(specText).find(item => item.language === language);
        if (!suite) throw new Error("No valid executable harness block parsed.");
        // One independent reference run catches malformed harnesses *before*
        // all candidates are tested. Successful evidence can be reused only for
        // identical code, harness and execution environment.
        if (suite.referenceCode) {
          const referenceProgram=spliceSuite(suite,suite.referenceCode);
          if (!referenceProgram) throw new Error("Reference could not be inserted.");
          const version = [
             pack.version,
             process.env.CODE_AUDITOR_E2B_TEMPLATE || "default",
             process.env.CODE_AUDITOR_E2B_TEMPLATE_REVISION || "unspecified",
             selectedCppStandard(process.env.CODE_AUDITOR_CPP_STANDARD),
             job.owner_id || "legacy",
           ].join(":");
          const key=referenceKey(language,suite.harness,suite.referenceCode,version);
          if (!isReferenceValidated(key)) {
            const outcome=await runVerification(settings,suite,referenceProgram);
            const cases=countCases(outcome.stdout);
            if (!outcome.ok || cases.failed!==0 || cases.passed<requiredHarnessCases(suite))
              throw new Error(`Reference self-test failed: ${cases.passed} passed and ${cases.failed} failed; at least ${requiredHarnessCases(suite)} validated case(s) are required; ${String(outcome.stderr||outcome.stdout||"no diagnostics").slice(0,600)}`);
            markReferenceValidated(key);
          }
          await addEvent(job.id,"info","harness_preflight_pass",
            `${language}: independent reference passed E2B.`,
            {language,checksum:key.slice(0,12)});
        } else {
          throw new Error(`${language} harness omitted its required independent reference implementation.`);
        }
        return suite;
      } catch (err) {
        lastError=err instanceof Error?err.message:String(err);
        const emptyCompletion = /empty model response|gateway returned malformed JSON/i.test(lastError);
        // A failed E2B account, network or sandbox is not an invalid harness.
        // Do not spend two more provider generations on an infrastructure fault.
        if (/No E2B key|E2B_API_KEY|quota|rate limit|sandbox unavailable|ECONNREFUSED|ETIMEDOUT|deadline_exceeded/i.test(lastError))
          throw err;
        failures.set(language, emptyCompletion
          ? `${model}: no usable test specification after bounded retries`
          : `${model}: ${lastError}`);
        // An empty/malformed completion in this auxiliary spec call is not
        // evidence that the model's already-produced solution is unavailable.
        // Keep the solver/judge seat eligible; continue with the next author.
        if (!emptyCompletion) await bench.note(model,err,"speccing");
        await addEvent(job.id,"warn", emptyCompletion ? "harness_provider_failed" : "spec_retry",
          emptyCompletion ? `Test preparation is retrying with another available agent.` :
            `${model} produced an invalid ${language} harness: ${lastError}`,
          {language, model, failureKind: emptyCompletion ? "gateway" : "harness",
            ...(emptyCompletion ? {} : {detail: lastError.slice(0, 300)})});
      }
    }
    return null;
  });
  const suites = suitesByLanguage.filter(Boolean);
  await addEvent(job.id, "info", "harness_generation_timing",
    `Generated ${suites.length}/${languages.length} language harness(es) in ${Date.now() - specStartedAt}ms.`,
    { elapsedMs: Date.now() - specStartedAt, languages: languages.length, generated: suites.length });
  const missing = missingSuiteLanguages(languages, suites);
  if (missing.length) {
    throw new Error(`Cannot verify coding solution in E2B: no executable ${missing.join(", ")} test harness was produced. ${missing.map(language=>failures.get(language)).filter(Boolean).join(" | ")}`);
  }


  return suites;
}

async function benchmarkCandidates(job, settings, baseUrl, models, judges, question, candidates, knowledge = "", bench, options = {}) {
  const codeCandidates=candidates.filter(c=>c.final?.kind==="code"&&c.final.code?.trim());
  if(!codeCandidates.length){
    await addEvent(job.id,"info","benchmark_skipped","No runnable code candidate.");
    return {suites:[],runs:{},oracles:[]};
  }
  const languages=[...new Set(codeCandidates.map(c=>candidateLanguage(c.final)).filter(Boolean))];
  const early=options.preparedSuites?await options.preparedSuites:[];
  const suitesEarly=early.filter(suite=>languages.includes(suite.language));
  const needed=missingSuiteLanguages(languages,suitesEarly);
  const later=needed.length?await prepareProblemHarnesses(job,settings,baseUrl,models,judges,question,candidates,needed,knowledge,bench):[];
  const suites=[...suitesEarly,...later];
  const missing=missingSuiteLanguages(languages,suites);
  if(missing.length)throw new Error("No executable E2B harness for "+missing.join(", "));
  await patchJob(job.id, { progress_phase: "verifying" });
  await addEvent(job.id, "info", "verifying", `Running ${codeCandidates.length} candidates through generated benchmarks.`);
  const eagerEntries=await Promise.all([...(options.eagerRuns||new Map())].map(async ([letter,promise])=>{
    try{return [letter,await promise]}catch{return [letter,null]}
  }));
  const completed=Object.fromEntries(eagerEntries.filter(([,run])=>run));
  const stillPending=candidates.filter(candidate=>!completed[candidate.letter]);
  const remaining=stillPending.length?await executeField(job,settings,suites,stillPending,{warmPool:options.warmPool}):{};
  const runs={...completed,...remaining};
  const oracles=await runMutationOracle(job, settings, suites, candidates, runs);
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
  // Separate screenshot specialists need not occupy a solver seat.
  // Each one still has to complete a real image-reading inference.
  const specialistSeats = preferredVisionModels(settings.availableModels || []).map(id => ({id}));
  const pool = bench.keep([...new Map([...specialistSeats, ...models]
    .map(seat => [seat.id, seat])).values()], m => m.id);
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
          reasoning: "off",
          ...(usesDirectGateway(settings) ? {responseFormat: {type: "json_object"}} : {}),
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
          reasoning: "off",
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
  const pack = knowledgePackFor(query, limit, library.records, true);
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
function trustedReadingCanStartSolving(reading, settings) {
  return Boolean(reading?.extraction) &&
    (reading.readers?.length ?? 0) >= 2 &&
    reading.agreement?.agree !== false &&
    Number(reading.extraction.confidence ?? 0) >= Number(settings.readingConfidenceFloor ?? 0.7) &&
    !(reading.extraction.ambiguities || []).length;
}

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
          reasoning: "off",
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

async function saveCouncilReport(job, report, alreadyExists = false) {
  const markdown = councilMarkdown(report);
  if (alreadyExists) {
    await updateSavedCouncilReport(job, report);
    return markdown;
  }
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

/** A partial verified report is queryable even while optional language ports run. */
async function updateSavedCouncilReport(job,report){
  await rest("council_reports?job_id=eq."+job.id,{
    method:"PATCH",
    body:JSON.stringify({
      winner:report.winner||null,synthesis:report.synthesis,
      markdown:councilMarkdown(report),report
    }),
  });
}

/**
 * Run an entirely fresh Council in the secondary language AFTER publishing
 * the primary answer. No verified Python/Rust/C++ source code is included in
 * ANY secondary solver or judge prompt. Each solver independently reasons from
 * the original question and is executed against a language-native E2B suite.
 * Only the strongest verified candidate is exposed in the language tabs.
 */
async function independentLanguageCouncil(job,settings,baseUrl,models,judges,question,
  target,knowledge,bench,originalImages=[],warmPool=null){
  const started=Date.now();
  const roster=[...new Set(bench.keep(models,seat=>seat.id).map(seat=>seat.id).filter(Boolean))].slice(0,4);
  const candidates=await Promise.all(roster.map(async(model,index)=>{
    const letter=letterFor(index);
    try{
      const text=await tokenRouterGenerate({
        settings,baseUrl,model,system:systemPrompt("code")+"\n"+independentLanguageInstruction(target),
        user:independentLanguageQuestion(question,target,knowledge),
        images:settings.probes?.[model]?.vision===true?originalImages:[],
        maxTokens:Math.max(Number(settings.maxTokens||4096),8192),
      });
      const parsed=parseFinal(text);
      const final=parsed?.kind==="code"&&candidateLanguage(parsed)===target&&parsed.code?.trim()?parsed:null;
      await addEvent(job.id,final?"info":"warn","independent_solver_result",
        target+" Candidate "+letter+(final?" is ready.":" did not return target-language code."),
        {language:target,letter,model,valid:Boolean(final)}).catch(()=>{});
      return {letter,model,final,text,error:null};
    }catch(error){
      return {letter,model,final:null,text:"",
        error:String(error instanceof Error?error.message:error).slice(0,300)};
    }
  }));
  const field=candidates.filter(item=>item.final?.kind==="code"&&item.final.code?.trim());
  if(!field.length)return {language:target,sourceLetter:"",model:"",code:"",
    status:"failed",error:"No independent "+target+" solver produced runnable code."};
  const suites=await prepareProblemHarnesses(job,settings,baseUrl,models,judges,
    question,field,[target],knowledge,bench);
  const suite=suites.find(item=>item.language===target);
  if(!suite)return {language:target,sourceLetter:"",model:"",code:"",
    status:"failed",error:"No accepted independent "+target+" E2B harness."};
  const runs=await executeField(job,settings,[suite],field,{warmPool,warmSeat:target});
  // The judge field is independent of the primary answer; its evaluation is
  // grounded in original constraints, actual candidate code and measured runs.
  const judging=bench.keep(judges,judge=>judge.model);
  const reports=await Promise.all(judging.map(async judge=>{
    try{
      const text=await tokenRouterGenerate({
        settings,baseUrl,model:judge.model,
        system:judgeSystemPrompt(judge.emphasis||"correctness"),
        user:judgeUserPrompt({question,docket:candidateDocket(field),
          reviews:"",execution:executionDigest(field,runs),knowledge}),
        images:settings.probes?.[judge.model]?.vision===true?originalImages:[],
        maxTokens:Number(settings.maxTokens||4096),
      });
      return {...parseJudgeReport(text),model:judge.model};
    }catch(error){
      await addEvent(job.id,"warn","independent_judge_failed",
        target+" independent judge unavailable.",
        {language:target,model:judge.model,detail:String(error).slice(0,160)}).catch(()=>{});
      return null;
    }
  }));
  const valid=reports.filter(report=>report?.wellFormed===true);
  if(!independentJudgesReady(judging.length,valid.length)){
    return {language:target,sourceLetter:"",model:"",code:"",status:"failed",
      error:"Independent "+target+" Council lacked enough complete judge evaluations; no solution promoted."};
  }
  const decision=decideWinner({
    claimed:"",judges:valid,runs,letters:field.map(item=>item.letter),
  });
  const chosen=field.find(candidate=>candidate.letter===decision.winner);
  const winningCode=chosen?.final?.code||"";
  if(!chosen||!winningCode||!isVerified(runs[chosen.letter])||
      !runs[chosen.letter]?.codeDigest||
      runs[chosen.letter].codeDigest!==createHash("sha256").update(winningCode).digest("hex")){
    return {language:target,sourceLetter:"",model:"",code:"",status:"failed",
      error:"No fingerprint-matched E2B-verified "+target+" winner; no untested source displayed."};
  }
  const mutation=await runMutationOracle(job,settings,[suite],[chosen],{[chosen.letter]:runs[chosen.letter]});
  if(mutation.some(signal=>signal.survived)){
    return {language:target,sourceLetter:"",model:"",code:"",status:"failed",
      error:"Independent "+target+" harness missed a mutation; winner withheld."};
  }
  await addEvent(job.id,"info","independent_language_winner",
    target+" independent Council selected E2B-verified Candidate "+chosen.letter+".",
    {language:target,letter:chosen.letter,model:chosen.model,elapsedMs:Date.now()-started,
      solvers:roster.length,judges:valid.length,passed:runs[chosen.letter].passed}).catch(()=>{});
  return {language:target,sourceLetter:chosen.letter,model:chosen.model,
    code:winningCode,status:"verified",run:runs[chosen.letter],
    independentCouncil:{solvers:roster.length,candidates:field.length,judges:valid.length,
      winner:chosen.letter,selection:decision.disagreement||"Measured E2B evidence and independent Council review"}};
}

async function saveMcqReport(job, answer, reading, raw = "", answerVerified = false) {
  const display = answerVerified && answer.options?.length
    ? formatMcqSelection(answer)
    : `${answer.answer?.label || ""} — ${answer.answer?.text || ""}`.trim();
  const markdown = [
    `# MCQ Answer`,
    "",
    `**Answer:** ${display}`,
    ...(!answerVerified ? ["", "**Verification:** Choices could not be independently matched to the screenshot reading."] : []),
    "",
    answer.reason || "",
    "",
    answer.whyNot?.length ? "## Why the others are not best" : "",
    ...(answer.whyNot || []).map((x) => `- ${x.label}: ${x.reason}`),
  ].filter(Boolean).join("\n");
  const report = {
    kind: "mcq",
    ...answer,
    answerVerified,
    displayAnswer: answerVerified && answer.options?.length ? formatMcqSelection(answer) : null,
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
  if (gatewayId(settings) !== "tokenrouter") return "chat";
  if (settings?.mcqEndpoint === "chat" || settings?.mcqEndpoint === "responses") return settings.mcqEndpoint;
  return endpointForCouncilModel(settings?.councilModels, model);
}

async function mcqGenerate({ settings, baseUrl, model, system, user, images = [], maxTokens = 2048 }) {
  const args = { baseUrl, model: gatewayModel(model, settings), system, user, images, maxTokens,
    apiKey: gatewayCredential(settings), paced: !usesDirectGateway(settings),
    reasoning: reasoningForModel(settings, model) };
  return mcqEndpointFor(settings, model) === "responses"
    ? tokenRouterResponses(args)
    : tokenRouterChat(args);
}

function mcqModel(settings, models) {
  const preferred = String(settings?.mcqModel || "anthropic/claude-fable-5.1").trim();
  const available = canonicalCouncilSeats([{ id: preferred }], (m) => m?.id, "id", settings?.availableModels);
  if (available.length && isSelectablePrimaryModel(available[0].id)) return available[0].id;
  return models[0]?.id || settings?.availableModels?.find(isSelectablePrimaryModel) || "claude-fable-5.1";
}

async function runMcqJob(job, { images = null, reading = null, bench = null } = {}) {
  await addEvent(job.id, "info", "claimed", "Cloud worker claimed the MCQ job.");
  await notify(job.id, APP_DISPLAY_NAME, "MCQ job started.");
  await addEvent(job.id, "info", "mcq", "MCQ overlay workflow selected.");
  await loadOwnerSecrets(job.owner_id);
  const settings = { ...(job.settings_snapshot || {}) };
  if (!gatewayCredential(settings)) {
    const message = `No ${gatewayId(settings)} key is saved for the account that owns this job.`;
    await addEvent(job.id, "error", "needs_attention", message);
    await patchJob(job.id, { status: "needs_attention", progress_phase: "needs_attention", error: message, finished_at: new Date().toISOString() });
    return;
  }

  const baseUrl = gatewayBaseUrl(settings);
  await discoverWorkerCatalog(settings);
  const roster = Array.isArray(settings.councilModels) && settings.councilModels.length
    ? settings.councilModels
    : COUNCIL_DEFAULT_MODELS;
  const models = canonicalCouncilSeats(roster, (m) => m?.id, "id", settings.availableModels)
    .filter(seat => isSelectablePrimaryModel(seat.id));
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
  const verified = detection.isMcq ? resolveMcqSelection(parsed, detection) : parsed;
  if (!verified) throw new Error("MCQ answer does not match the extracted options.");
  if (verified !== parsed) Object.assign(parsed, verified);
  parsed.model = parsed.model || model;
  parsed.knowledgeUsed = Boolean(parsed.knowledgeUsed || knowledge.trim());
  if (!detection.isMcq) {
    await addEvent(job.id, "warn", "options_unverified", "The screenshot reading did not yield independently verifiable choices. Displaying the model's answer without a verified-option mark.");
  }
  const markdown = await saveMcqReport(job, parsed, mcqReading, raw, detection.isMcq);
  await patchJob(job.id, {
    status: "completed",
    progress_phase: "completed",
    mode: "mcq",
    error: null,
    result_summary: (detection.isMcq ? formatMcqSelection(parsed) : `Unverified choices: ${parsed.answer.label}: ${parsed.answer.text || parsed.reason}`).slice(0, 500),
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

function looksLikeCodingPrompt(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  const strong = /\b(?:leetcode|hackerrank|codeforces|programming problem|write an? (?:algorithm|function|program)|implement (?:a|the) (?:function|class|solution))\b/i;
  const judgeStub = /\bclass\s+Solution\b|\bdef\s+[A-Za-z_]\w*\s*\([^\n]*\)|\bfunction\s+[A-Za-z_]\w*\s*\(|\bpublic\s+(?:static\s+)?[\w:<>,\[\]\s*&]+\s+[A-Za-z_]\w*\s*\(/i;
  const specShape = /\bconstraints\b/i.test(value) && /\bexamples?\s*\d*\s*:/i.test(value) &&
    /\b(?:return|output|input)\b/i.test(value);
  return strong.test(value) || judgeStub.test(value) || specShape;
}

export async function runCouncilJob(job) {
  let warmPool = null;
  try {
  if (job.mode === "mcq") {
    await runMcqJob(job);
    return;
  }

  await addEvent(job.id, "info", "claimed", "Cloud worker claimed the job.");
  await notify(job.id, APP_DISPLAY_NAME, "Council job started.");

  // Whose job is this, and therefore whose keys pay for it.
  await loadOwnerSecrets(job.owner_id);
  const settings = { ...(job.settings_snapshot || {}) };

  if (!gatewayCredential(settings)) {
    const message = `No ${gatewayId(settings)} key is saved for the account that owns this job.`;
    await addEvent(
      job.id,
      "error",
      "needs_attention",
      message
    );
    await patchJob(job.id, {
      status: "needs_attention",
      progress_phase: "needs_attention",
      error: message,
      finished_at: new Date().toISOString(),
    });
    await notify(job.id, APP_DISPLAY_NAME, `Council job needs ${gatewayId(settings)} configuration.`);
    await notifyOps({
      level: "warn",
      title: "Council job needs attention",
      body: message,
      jobId: job.id,
      phase: "needs_attention",
    }).catch(() => {});
    return;
  }

  const baseUrl = gatewayBaseUrl(settings);
  // Overlay screenshots are already uploaded under this job's immutable image
  // manifest. Fetch that manifest first, then launch the independent Trusty
  // request immediately with the original screenshots—before catalogue
  // discovery, capability/eligibility checks, readers, or Council selection.
  await patchJob(job.id, { progress_phase: "downloading_images" });
  await addEvent(job.id, "info", "downloading_images", "Downloading ordered screenshots from configured private storage.");
  const images = await downloadJobImages(job.id);
  if (!images.length) throw new Error("The job has no downloadable screenshots.");
  await addEvent(job.id, "info", "images_ready",
    `Prepared ${images.length} direct image link${images.length === 1 ? "" : "s"} for the solving lanes.`,
    { count: images.length, positions: images.map((image) => image.position) });

  const startTrustyBeforeSelection = settings.codingTrustyEnabled !== false &&
    settings.source === "overlay" && settings.overlayMode === "code";
  const trustyGatewayForRun = trustyGateway(settings);
  const trustyModelForRun = gatewayPreset(trustyGatewayForRun).trustyModel ?? preferredPrimaryRoute("claude-fable-5.1", trustyGatewayForRun);
  let earlyTrustyDraftPromise = null;
  if (startTrustyBeforeSelection) {
    if (!secret(trustyGatewayForRun)) {
      await addEvent(job.id, "warn", "coding_trusty_unavailable",
        `Coding Trusty needs the account's saved ${trustyGatewayForRun} credential; Council selection continues normally.`,
        { model: trustyModelForRun });
    } else {
      const trustyLanguage = configuredCodeLanguage(settings.outputLanguage);
      const languageLabel = trustyLanguage === "cpp" ? "C++" : trustyLanguage === "rust" ? "Rust" : "Python";
      await addEvent(job.id, "info", "coding_trusty_started",
        `Coding Trusty (Claude Fable 5.1 · ${trustyGatewayForRun}) is starting from the uploaded screenshots before Council model selection.`,
        { model: trustyModelForRun, language: trustyLanguage, screenshotCount: images.length });
      const trustyBaseUrl = gatewayBaseUrl({ gatewayId: trustyGatewayForRun });
      const trustySettings = { ...settings, gatewayId: trustyGatewayForRun, gatewayBaseUrl: trustyBaseUrl, availableModels: [] };
      earlyTrustyDraftPromise = tokenRouterGenerate({
        settings: trustySettings,
        baseUrl: trustyBaseUrl,
        model: trustyModelForRun,
        system: systemPrompt("code", { id: trustyLanguage, display: languageLabel }),
        user: [
          "You are Coding Trusty, the fast independent preflight solver for the Coding overlay.",
          "Read every supplied original screenshot and solve the exact coding problem now; do not wait for Council model selection or screenshot-reader results.",
          `Use ${languageLabel} unless the problem explicitly requires a different language. Preserve the exact judge signature or input/output interface shown in the screenshots.`,
          "Before returning, mentally check the function signature, visible example inputs and outputs, and common edge cases. Return one complete Council FINAL block with KIND: code, LANGUAGE, ANSWER, COMPLEXITY, and a closed fenced source block. Do not claim tests were executed; E2B will check the code before display.",
        ].join("\n\n"),
        images,
        maxTokens: Math.max(Number(settings.maxTokens || 4096), 8192),
        reasoning: "off",
      }).then(text => ({ text, model: trustyModelForRun, language: trustyLanguage }))
        .catch(error => ({ error: String(error instanceof Error ? error.message : error), model: trustyModelForRun, language: trustyLanguage }));
    }
  }

  await discoverWorkerCatalog(settings);
  // Do not decide solver seats from the stored Council roster.  Main and
  // overlay both begin with every enabled approved model; a coordinator reads
  // this job's original screenshots and chooses the four independent solvers.
  const useAdaptiveSolverSelection = hasAdaptiveSolverSelection(settings);
  let models = approvedSolverPool(settings);
  const judges = chatJudges(settings);

  // A seat the key has no access to is not worth a request to discover. The
  // router's catalogue already answered that for every model at once, so the
  // seat is dropped here — but never silently, because a roster that quietly
  // shrinks is how a four-solver Council becomes a two-solver Council without
  // anyone noticing.
  const missing = [
    ...unreachableCouncilSeatIds(
      Array.isArray(settings.councilJudges) ? settings.councilJudges : COUNCIL_DEFAULT_JUDGES,
      (j) => j?.model, settings.availableModels
    ),
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
        ? `Cloud Council needs at least two reachable approved models, and this key cannot reach judge route(s): ${missing.join(", ")}. ` +
          "Refresh the model list in Settings."
        : "Cloud Council needs at least two enabled approved models."
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

  // Match the desktop's reader configuration exactly. The overlay's only
  // difference is how screenshots arrive; it must not quietly substitute
  // Council solver seats for the configured screenshot readers.
  const roster = Array.isArray(settings.councilModels) && settings.councilModels.length
    ? settings.councilModels
    : COUNCIL_DEFAULT_MODELS;
  const configuredReaders = screenshotReaderSeats(settings, roster);
  const readerPool = partitionByVision(
    bench.keep(configuredReaders, (m) => m.id),
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
  if (settings.overlayMode === "auto" && images.length === 1 && overlayReadingText && detectMcq(overlayReadingText).isMcq) {
    await addEvent(job.id, "info", "mcq_detected", "Auto overlay mode detected multiple-choice answer options.");
    await runMcqJob({ ...job, settings_snapshot: settings, mode: "mcq" }, { images, reading, bench });
    return;
  }

  // A reconstruction is useful shared context and can avoid a second contract
  // pass. It is never a substitute for source-image evidence: every solver
  // selected for an image job must independently inspect the original capture.
  const readingTrusted = trustedReadingCanStartSolving(reading, settings);

  // `solveFrom` is retained for backwards-compatible settings snapshots, but
  // cannot weaken the evidence rule for a screenshot job. A text-only route
  // must never be promoted merely because readers agreed about their transcript.
  const showPicture = images.length > 0;
  let solving = showPicture ? seeing : available;
  const solveImages = showPicture ? images : [];
  if (showPicture && !solving.length) {
    throw new Error("No reachable vision-capable solver is available for this screenshot. Verify the selected model roster and image-capability probes.");
  }

  // Match the desktop's adaptive panel selection.  The coordinator is allowed
  // to inspect the submitted screenshots only to classify the work and select
  // specialists. Every selected solver still receives the original immutable
  // image manifest and solves independently; no coordinator transcription is
  // treated as the problem statement.
  const selectionCandidates = solving.map((seat) => ({
    id: seat.id,
    model: seat.id,
    canSeeImages: true,
  }));
  const selection = useAdaptiveSolverSelection ? await coordinateAndVerify({
    candidates: selectionCandidates,
    catalogue: settings.availableModels || [],
    note: [reading.context, reading.markdown].filter(Boolean).join("\n\n").slice(0, 2800),
    screenshotCount: solveImages.length,
    fallbackOrder: selectionCandidates.map((seat) => seat.id),
    preferredCoordinator: gatewayPreset(settings.gatewayId).coordinatorModel,
    probe: async (routes, needsVision) => {
      // A fresh Clean API catalogue is already an entitlement and capability
      // check. The first actual selected-solver call carries this job's direct
      // Azure image URLs, which is the meaningful end-to-end validation.
      const catalogued = new Set(settings.availableModels || []);
      return routes.map((model) => ({
        model,
        ok: !catalogued.size || catalogued.has(model),
        ms: 0,
        error: !catalogued.size || catalogued.has(model) ? null : "not listed by the current gateway credential",
        vision: needsVision ? true : null,
        visionNote: needsVision
          ? "Approved route; the independent solver receives this job's direct image links."
          : null,
      }));
    },
    ask: (model, prompt) => tokenRouterGenerate({
      settings,
      baseUrl,
      model,
      system: prompt.systemPrompt,
      user: prompt.userText,
      images: solveImages,
      maxTokens: 360,
      reasoning: "off",
    }),
  }) : null;
  if (selection) {
    const selectedIds = new Set(selection.routes.map((route) => route.id));
    solving = solving.filter((seat) => selectedIds.has(seat.id));
    if (!solving.length) {
      throw new Error("The coordinator could not validate an eligible solver route for this submission. Refresh the live model list and try again.");
    }
    // All later candidate, harness, revision, and Council phases operate on
    // the same selected four rather than silently reverting to a configured
    // roster.
    models = solving;
    await addEvent(
      job.id,
      "info",
      "solvers_selected",
      `Coordinator selected ${solving.map((seat) => seat.id).join(", ")} after reading the submission.`,
      {
        models: solving.map((seat) => seat.id),
        coordinator: selection.coordinator,
        family: selection.family,
        reason: selection.reason,
        rejected: selection.rejected,
      }
    );
  }

  // The first two independent evidence readers prefer the three available
  // CleanAPI specialist families. No source code or previous answer is shared.
  const specialistRoutes = preferredVisionModels(settings.availableModels || []);
  const evidenceCandidateIds = [...specialistRoutes, ...models.map(seat => seat.id),
    ...(settings.councilJudges || []).map(seat => seat.model)];
  const evidenceSeats = [...new Map(evidenceCandidateIds.filter(Boolean)
    // Already-benched routes must not be called again by optional readers.
    .filter(id => !bench.has(id) && !bench.isBlind(id))
    .filter(id => isSelectablePrimaryModel(id))
    .map(id => [primaryModelId(id), id])).values()]
    .sort((a, b) => {
      const ar = VISION_PREFERENCE.findIndex(v => primaryModelId(v) === primaryModelId(a));
      const br = VISION_PREFERENCE.findIndex(v => primaryModelId(v) === primaryModelId(b));
      return (ar < 0 ? 999 : ar) - (br < 0 ? 999 : br);
    }).slice(0,3);
  const readOriginalExamples = async model => {
    try {
      return await tokenRouterGenerate({
        settings, baseUrl, model, system: visionEvidenceSystemPrompt(),
        user: "Independently transcribe only labelled examples from the ORIGINAL pixels into strict JSON; never infer an expected answer.",
        images, maxTokens: 3600, reasoning: "off",
        ...(usesDirectGateway(settings) ? {responseFormat: {type: "json_object"}} : {}),
      });
    } catch { return ""; }
  };
  const evidenceReadingsReady = images.length > 0
    ? Promise.all(evidenceSeats.slice(0,2).map(readOriginalExamples))
    : Promise.resolve([]);

  await patchJob(job.id, { progress_phase: "solving" });

  // Everything the desktop path sends, which until now none of was sent: the
  // reading of the picture, the knowledge selected for this question, a real
  // manifest, and the house preference for what to write it in.
  const timer = phaseTimer();
  timer.enter("contract");
  const policy = solutionPolicy([configuredCodeLanguage(settings.outputLanguage)], Number(settings.memoryTargetKb || 20 * 1024));
  // No knowledge argument here on purpose. `knowledgePackFor` retrieves against
  // text, and before anybody has answered there is no text — only a picture.
  // The library arrives the moment the panel produces words, which is also the
  // moment the system can tell this is a coding problem at all.
  const baseQuestion = userPrompt("", solveImages.length > 0, reading.context, imageRefs, "", policy);

  // Everything downstream — solvers, the harness spec, reviews, revisions,
  // judges, the synthesis — is handed this same string as "the problem". Folding
  // the contract into it once is what makes it immutable ground truth for the
  // whole run rather than a paragraph one stage happened to be given.
  // Two independent, high-confidence image readings already establish the
  // problem text. Re-asking two of those same routes to restate it is a serial
  // gate which delays solver assignment without adding evidence. Keep the
  // contract pass for uncertainty, disagreement, typed-only tasks, and every
  // other case where its independent specification check earns its cost.
  const reuseTrustedReading = readingTrusted && Boolean(reading.context?.trim());
  const contracting = reuseTrustedReading
    ? (() => {
        void addEvent(
          job.id,
          "info",
          "problem_contract_reused",
          "The two screenshot readers agreed with high confidence; using that verified reading directly and starting the Council solvers now.",
          { readers: reading.readers, confidence: reading.extraction?.confidence ?? null }
        );
        return { contract: null, agreement: null, readers: reading.readers || [] };
      })()
    : await readProblemContract({
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
  const evidenceReady = evidenceReadingsReady.then(async readings => {
    const originalContext = [reading.context, contractText].filter(Boolean).join("\n\n");
    let evidence = reconcileProblemEvidence(originalContext, images.length > 0, readings);
    if (images.length > 0 && evidenceSeats[2] &&
        (evidence.status !== "corroborated" || evidence.disagreements.length > 0)) {
      const third = await readOriginalExamples(evidenceSeats[2]);
      evidence = reconcileProblemEvidence(originalContext, true, [...readings, third]);
    }
    return evidence;
  });

  // The library, before the first attempt rather than after it.
  //
  // Retrieval matches text against text, and a screenshot is not text — which
  // is why this used to wait until the solvers had written something and then
  // hand the library to every round except the one that produced the answers.
  // The contract is text about the problem, written before anybody attempted
  // it, so the pack can reach round one now. Only for problems the readers
  // called code: retrieving cp-algorithms and perf counters for a
  // multiple-choice question is noise charged four times over.
  // Screenshot reading/contract classification can be empty even when OCR has
  // captured an unmistakable programming prompt. Classify from the supplied
  // problem before asking solvers; never infer the task type from their output.
  const questionLooksLikeCode = looksLikeCodingPrompt([baseQuestion, reading.context,
    reading.extraction?.problemSummary, reading.extraction?.code].filter(Boolean).join("\n"));
  const inferredKind = settings.overlayMode === "code" ? "code" : questionLooksLikeCode
    ? "code"
    : (contracting.contract?.kind || reading.extraction?.kind || "");
  const languageEvidence=[contractText, reading.extraction?.code || ""].join("\n");
  const primaryLanguage=/\bLANGUAGES:\s*(?:javascript|js)\b|\bexport\s+(?:default\s+)?function\s+[A-Za-z_$]\w*\s*\(/i.test(languageEvidence)
    ? "javascript" : requiredProblemLanguage(question)||configuredCodeLanguage(settings.outputLanguage);
  const documentationQuery = [question, reading.extraction?.problemSummary,
    reading.extraction?.code].filter(Boolean).join("\n");
  const detectedDocsLanguage = inferDocumentationLanguage(documentationQuery,
    reading.extraction?.language || settings.outputLanguage || primaryLanguage);
  // Proactive reference lookup before the first solver: bounded, cached,
  // server-side and topic-specific, never a full-site download.
  // Both reads depend on the completed problem contract, but NOT on each other.
  // Overlap the personal-server HTML fetch with library/database retrieval.
  const [initialReference, initialKnowledge] = await Promise.all([
    inferredKind === "code" || detectedDocsLanguage
      ? fetchAuthoritativeLanguageContext(documentationQuery, {
          language:detectedDocsLanguage || "python"
        })
      : Promise.resolve({language:"",source:"not-applicable",prompt:"",pages:[]}),
    inferredKind === "code"
      ? selectKnowledge(job, settings, {contract: contracting.contract, reading})
      : Promise.resolve(""),
  ]);
  if(initialReference.prompt)await addEvent(job.id,"info","language_reference_primary",
    "Loaded focused documentation from the personal server before solving.",
    {language:initialReference.language,source:initialReference.source,
     pages:initialReference.pages.map(page=>page.url)});
  let knowledge = initialKnowledge;
  // Reader calls were started alongside contract, docs and knowledge lookup.
  // Join them before the solver requests so only independently confirmed
  // screenshot examples are supplied as extra facts to every selected solver.
  const screenshotEvidence = await evidenceReady;
  await addEvent(job.id, screenshotEvidence.disagreements.length ? "warn" : "info",
    "screenshot_evidence", "Independent screenshot example checks finished before solving.",
    {status:screenshotEvidence.status,confirmed:screenshotEvidence.fixtures.length,
      reviewers:screenshotEvidence.reviewers,disagreements:screenshotEvidence.disagreements}).catch(()=>{});
  const solverPrompt = [
    userPrompt("", solveImages.length > 0, reading.context, imageRefs,
      [initialReference.prompt,knowledge].filter(Boolean).join("\n\n"), policy),
    contractText,
    evidenceSolverBrief(screenshotEvidence),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n")+
    (inferredKind==="code"
      ? "\n\nThe FIRST solving stage must output only "+primaryLanguage+
        " code unless the original problem explicitly demands another language."+
        " Rust and C++ translations will be generated later from the E2B-verified winning solution."
      : "");

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
    primaryLanguage === "cpp" ? "C++" : primaryLanguage === "rust" ? "Rust" : primaryLanguage === "python" ? "Python" : "",
    String(reading.extraction?.language || "")
  );
  await addEvent(job.id, "info", "answer_language", `Answering in ${answerLanguage.display || "the question's own language"}.`, {
    id: answerLanguage.id,
    source: answerLanguage.source,
  });
  const solverSystem = systemPrompt(inferredKind === "code" ? "code" : (settings.mode || "auto"), answerLanguage);
  const candidates = [];
  // Vision-qualified judges inspect literal screenshot examples while the
  // agents solve. Unconfirmed OCR never becomes authoritative E2B assertions.
  const earlyLanguages=contractSupportsEarlyHarness(
    [reading.context,contractText,question].filter(Boolean).join("\n"),inferredKind
  )?[primaryLanguage]:[];
  // Do not ask for a speculative harness before a solver has returned code.
  // That old path competed with the actual screenshot solvers for the same
  // gateway, then often guessed an interface without a real candidate.  Start
  // the first candidate-aware harness as soon as a code answer lands instead;
  // it still overlaps the remaining solvers and E2B warm-up, but uses a proven
  // route and the real signature the harness must exercise.
  let preparedSuites = Promise.resolve([]);
  let earlyHarnessStarted = false;
  const beginCandidateAwareHarness = (candidate) => {
    if (earlyHarnessStarted || !candidate?.final?.wellFormed || !candidate.final.code?.trim()) return;
    const language = candidateLanguage(candidate.final);
    if (!earlyLanguages.includes(language)) return;
    earlyHarnessStarted = true;
    preparedSuites = evidenceReady.then(evidence => prepareProblemHarnesses(
      job, settings, baseUrl, models, judges, evidence.question, [candidate], [language], knowledge, bench
    )).catch(async (err) => {
      await addEvent(job.id,"warn","early_harness_fallback","Early candidate-aware E2B harness unavailable; the complete field will be retried.",
        {detail:String(err).slice(0,180), language, model:candidate.model}).catch(()=>{});
      return [];
    });
  };
  const scheduleE2B=createBoundedExecutor(workerConcurrency(process.env.CODE_AUDITOR_E2B_CONCURRENCY,4,9));
  const eagerRuns=new Map();
  // Only the FIRST eligible candidate is displayed provisionally. It is an
  // E2B-tested work-in-progress, NOT the Council's winner. Final selection is
  // still postponed until all solvers, reviewers and judges finish.
  const provisionalState={record:null,persisted:false,writing:Promise.resolve()};
  const provisionalLock={claimed:false};
  const publishProvisional=async(candidate,run)=>{
    if(provisionalLock.claimed || provisionalState.record || !candidate?.final || !run) return;
    if(candidateLanguage(candidate.final)!==primaryLanguage)return;
    const screened=screenProvisionalCandidate({
      final:candidate.final,run,contractComplexity:contracting.contract?.complexity||""
    });
    if(!screened.eligible)return;
    provisionalLock.claimed=true;
    const provisional=createProvisionalRecord({
      candidate,run,language:primaryLanguage,screened
    });
    provisionalState.record=provisional;
    const preliminary={
      stage:"provisional",standing:"provisional",winner:null,
      provisional,solutionHistory:buildSolutionHistory(provisional,null),
      synthesis:candidate.codingTrusty
        ? "Claude Fable 5.1 Coding Trusty produced an early E2B-tested answer. This is NOT the final Council selection; the four independent solvers, review, harness quality checks, and judging remain pending."
        : "An early E2B-tested candidate is available. This is NOT the final Council selection; independent review, harness quality checks, and judging remain pending.",
      // Persist the exact first complete candidate and its original E2B
      // result immediately, so the history, current overlay, and later
      // candidate comparison share a stable evidence snapshot.
      candidates:[candidate],reviews:[],judges:[],
      runs:{[candidate.letter]:run},revisedRuns:{},oracles:[],
      ports:[],suites:[],
    };
    // No competing writers may replace this row until initial save settles.
    provisionalState.writing=(async()=>{
      await saveCouncilReport(job,preliminary);
      provisionalState.persisted=true;
      await addEvent(job.id,"info","provisional_solution_ready",
        (candidate.codingTrusty ? "Coding Trusty (Claude Fable 5.1)" : "Candidate "+candidate.letter)+" passed E2B and initial complexity screening; provisional code is available while Council evaluates all models.",
        {letter:candidate.letter,language:primaryLanguage,passed:run.passed,
          model:candidate.model,codingTrusty:Boolean(candidate.codingTrusty),
          complexityClaim:screened.claimedBound,complexityAudited:false});
    })().catch(async(error)=>{
      provisionalLock.claimed=false;
      provisionalState.record=null;
      await addEvent(job.id,"warn","provisional_save_failed",
        "Could not display an early solution; final Council verification continues.",
        {detail:String(error).slice(0,200)}).catch(()=>{});
    });
    await provisionalState.writing;
  };

  // Coding Trusty is an extra, independent Claude Fable 5.1 preflight for overlay jobs,
  // not a fifth selected solver and not a replacement for the four seats. It
  // uses the owner's Clean API credential, the same screenshot/contract/
  // knowledge evidence, and the same E2B execution gate as every candidate.
  // The bounded self-review happens before its source is sent to E2B.
  const trustyEligible = settings.codingTrustyEnabled !== false && inferredKind === "code" &&
    ["python", "cpp", "rust"].includes(primaryLanguage);
  let trustyCandidate = null;
  let trustyRunPromise = Promise.resolve(null);
  let trustyPromise = Promise.resolve(null);
  if (trustyEligible) {
    trustyPromise = (async () => {
      const trustyGatewayForRun = trustyGateway(settings);
      const trustyBaseUrl = gatewayBaseUrl({ gatewayId: trustyGatewayForRun });
      const trustySettings = { ...settings, gatewayId: trustyGatewayForRun, gatewayBaseUrl: trustyBaseUrl, availableModels: [] };
      const trustyModel = gatewayPreset(trustyGatewayForRun).trustyModel ?? preferredPrimaryRoute("claude-fable-5.1", trustyGatewayForRun);
      try {
        if (!secret(trustyGatewayForRun)) {
          await addEvent(job.id, "warn", "coding_trusty_unavailable",
            `Coding Trusty needs the account's saved ${trustyGatewayForRun} credential; the four Council solvers continue normally.`,
            { model: trustyModel });
          return null;
        }
        if (!earlyTrustyDraftPromise) {
          await addEvent(job.id, "info", "coding_trusty_started",
            `Coding Trusty (Claude Fable 5.1 · ${trustyGatewayForRun}) is independently solving the problem alongside the four Council agents.`,
            { model: trustyModel, language: primaryLanguage });
        }
        const trustySystem = systemPrompt("code", answerLanguage);
        const earlyDraft = earlyTrustyDraftPromise ? await earlyTrustyDraftPromise : null;
        if (earlyDraft?.error) throw new Error(earlyDraft.error);
        const firstText = earlyDraft?.text || await tokenRouterGenerate({
          settings: trustySettings, baseUrl: trustyBaseUrl, model: trustyModel,
          system: trustySystem,
          user: solverPrompt + "\n\n" +
            "You are Coding Trusty: independently return your strongest complete solution in " + primaryLanguage +
            ". Include accurate time and auxiliary-space complexity. This answer is provisional, not Council-approved.",
          images: solveImages,
          maxTokens: Math.max(Number(settings.maxTokens || 4096), 8192), reasoning: "high",
        });
        let final = parseFinal(firstText);
        if (!final?.wellFormed || final.kind !== "code" || !final.code?.trim() || candidateLanguage(final) !== primaryLanguage) {
          if (!earlyDraft) throw new Error("Claude Fable 5.1 did not return a complete " + primaryLanguage + " code answer.");
          const recoveryText = await tokenRouterGenerate({
            settings: trustySettings, baseUrl: trustyBaseUrl, model: trustyModel,
            system: trustySystem,
            user: solverPrompt + "\n\nYour early preflight answer was not parseable as complete " + primaryLanguage +
              " code. Return the complete solution now in exactly one closed Council FINAL block; do not omit code.",
            images: solveImages, maxTokens: Math.max(Number(settings.maxTokens || 4096), 8192), reasoning: "high",
          });
          final = parseFinal(recoveryText);
          if (!final?.wellFormed || final.kind !== "code" || !final.code?.trim() || candidateLanguage(final) !== primaryLanguage) {
            throw new Error("Claude Fable 5.1 did not return a complete " + primaryLanguage + " code answer.");
          }
        }
        // The original Fable request already performed an explicit internal
        // example/interface check. Requiring three more complete Fable
        // generations added minutes without providing executable evidence.
        // Strict parsing plus E2B, not another AI response, is the gate.
        await addEvent(job.id, "info", "coding_trusty_self_review",
          "Fable checked its draft against the screenshot instructions; preparing actual E2B tests.",
          { model: trustyModel, language: primaryLanguage, method: "initial-solve-check" });
        const candidate = {
          letter: "T", model: trustyModel, final, text: firstText,
          error: null, codingTrusty: true,
        };
        trustyCandidate = candidate;
        await addEvent(job.id, "info", "coding_trusty_testing",
          "Claude Fable 5.1's reviewed answer is being checked against the problem test suite in E2B.",
          { model: trustyModel, letter: "T", language: primaryLanguage });
        // Source-provided literal tests need no second AI author. Build this
        // deterministic adapter first; only fall back to an independent,
        // E2B-self-tested generated harness when source fixtures are absent.
        const verifiedFixtureQuestion = screenshotEvidence.fixtures?.length
          ? [screenshotEvidence.question || question,
             ...screenshotEvidence.fixtures.map((pair,index) =>
               "Example "+(index+1)+":\nInput: "+pair.input+"\nOutput: "+pair.output)]
              .join("\n\n")
          : screenshotEvidence.question || question;
        const providedSuite = buildProvidedHarness(
          verifiedFixtureQuestion, primaryLanguage, final.code);
        if (providedSuite) await addEvent(job.id,"info","coding_trusty_provided_tests",
          "Prepared the question's own test cases without a new AI model call.",
          {model:trustyModel,language:primaryLanguage,cases:providedSuite.providedCaseCount});
        const suites = providedSuite ? [providedSuite] :
          await prepareProblemHarnesses(job, settings, baseUrl, models, judges,
            screenshotEvidence.question || question, [candidate], [primaryLanguage], knowledge, bench);
        const suite = suites.find(item => item.language === primaryLanguage);
        if (!suite) throw new Error("No executable " + primaryLanguage + " test suite was available for the Trusty answer.");
        const runs = await executeField(job, settings, [suite], [candidate]);
        const run = runs.T;
        if (!run?.ran || !run.ok || run.failed !== 0 || run.passed < requiredHarnessCases(suite)) {
          throw new Error("Claude Fable 5.1's preflight answer did not pass the E2B test suite.");
        }
        trustyRunPromise = Promise.resolve(run);
        eagerRuns.set("T", trustyRunPromise);
        await addEvent(job.id, "info", "coding_trusty_e2b_passed",
          "Claude Fable 5.1 passed the E2B test suite; Council will independently review the answer before selecting a final solution.",
          { model: trustyModel, letter: "T", language: primaryLanguage, passed: run.passed, failed: run.failed });
        await publishProvisional(candidate, run);
        return candidate;
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).replace(/<[^>]*>/g, " ").slice(0, 260);
        await addEvent(job.id, "warn", "coding_trusty_failed",
          "Coding Trusty could not produce a verified preflight answer; the four Council agents continue unchanged.",
          { model: trustyModel, error: message });
        return null;
      }
    })();
  }

  // Opt-in canary: four independent E2B copies are created while the solver
  // models reason, ready for their first Python E2B candidate runs. Never warm
  // MCQ jobs, absent E2B credentials, or an unsupported primary language.
  const pythonStandbyCount=standbyBudget(E2B_CAPACITY.snapshot(),Math.min(4,solving.length));
  if (process.env.CODE_AUDITOR_E2B_PREWARM === "1" &&
      inferredKind === "code" && primaryLanguage === "python" &&
      pythonStandbyCount > 0 && secret("E2B_API_KEY")) {
    warmPool = createE2BWarmPool({
      idleMs: E2B_WARM_IDLE_MS,
      create: letter => createE2BLease({
        executionId: executionId(), purpose: "standby-python",
        slot: letter, jobId: job.id,
        timeoutMs: Math.max(REMOTE_RUN_TIMEOUT_MS + E2B_WARM_IDLE_MS + 60_000, 180_000),
      }),
      destroy: async lease => {
        try { await lease.sandbox.kill(); }
        finally { lease.release(); }
      },
      onEvent: (name, meta) => addEvent(job.id, name === "failed" ? "warn" : "info",
        "e2b_prewarm_" + name, "Standby Python sandbox " + name + " for " + meta.letter,
        meta).catch(() => {}),
    });
    warmPool.prewarm(solving.slice(0,pythonStandbyCount).map((_, index) => letterFor(index)));
    await addEvent(job.id,"info","e2b_prewarm_requested",
      "Requested up to four isolated standby Python sandboxes; idle sandboxes expire automatically.",
      {seats:pythonStandbyCount,idleMs:E2B_WARM_IDLE_MS,
       capacity:E2B_CAPACITY.snapshot()});
  }
  timer.enter("solving");
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
          // Complete implementations for image-transcribed tasks routinely
          // exceed the short default. An open/truncated FINAL is recoverable,
          // but give the initial solver room to finish first.
          maxTokens: inferredKind === "code"
            ? Math.max(Number(settings.maxTokens || 4096), 8192)
            : Number(settings.maxTokens || 4096),
          reasoning: inferredKind === "code" ? "high" : undefined,
        });
        const final = parseFinal(text);
        candidates[index] = { letter, model: spec.id, final, text, error: null };
        if (final?.kind === "code" && final.wellFormed && final.code?.trim()) {
          beginCandidateAwareHarness(candidates[index]);
        }
        if(final?.kind==="code"&&final.wellFormed&&final.code?.trim()&&earlyLanguages.includes(candidateLanguage(final))){
          eagerRuns.set(letter,scheduleE2B(async()=>{
            const ready=await preparedSuites;
            const suite=ready.find(item=>item.language===candidateLanguage(final));
            if(!suite)return null;
            const output=await executeField(job,settings,[suite],[candidates[index]],{warmPool});
            const run=output[letter]||null;
            if(run) await publishProvisional(candidates[index],run);
            return run;
          }).catch(async err=>{
            await addEvent(job.id,"warn","eager_e2b_fallback","Early Candidate "+letter+" execution failed to start; normal E2B remains available.",
              {letter,detail:String(err).slice(0,180)}).catch(()=>{});
            return null;
          }));
        }
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

  // One bounded format-recovery attempt for each solver that answered but did
  // not return a complete source block. This only spends extra calls for
  // incomplete candidates and does not change the selected model roster.
  if (inferredKind === "code") {
    const recoveryTargets = candidates.filter((candidate) =>
      !(candidate?.final?.kind === "code" && candidate.final.wellFormed && candidate.final.code?.trim() &&
        candidateLanguage(candidate.final) === primaryLanguage) &&
      (candidate?.text || /empty model response/i.test(candidate?.error || ""))).slice(0, 4);
    if (recoveryTargets.length) {
      await addEvent(job.id, "warn", "solver_code_recovery_started",
        `Requesting one complete ${primaryLanguage} source block from ${recoveryTargets.length} solver(s) whose first reply contained no usable code.`,
        { models: recoveryTargets.map((candidate) => candidate.model), language: primaryLanguage });
      await Promise.all(recoveryTargets.map(async (candidate) => {
        try {
          const retryText = await tokenRouterGenerate({
            settings,
            baseUrl,
            model: candidate.model,
            system: systemPrompt("code", { ...answerLanguage, id: primaryLanguage, display: primaryLanguage }),
            user: [
              "Your previous response did not contain a complete, parseable implementation. Solve the same problem now.",
              "Return exactly one complete implementation in the requested language, inside a closed Council FINAL block. Do not return analysis without code, omit no lines, and do not stop mid-fence.",
              "Problem and interface:\n" + question,
              "Previous response (for context only; do not repeat its truncation):\n" + candidate.text.slice(-3500),
            ].join("\n\n"),
            images: solveImages,
            maxTokens: Math.max(Number(settings.maxTokens || 4096), 8192),
            reasoning: "high",
          });
          const retryFinal = parseFinal(retryText);
          if (retryFinal?.kind === "code" && retryFinal.wellFormed && retryFinal.code?.trim() && candidateLanguage(retryFinal) === primaryLanguage) {
            candidate.final = retryFinal;
            candidate.text = retryText;
            candidate.error = null;
            beginCandidateAwareHarness(candidate);
            await addEvent(job.id, "info", "solver_code_recovery_done",
              `${candidate.model} returned a complete ${primaryLanguage} implementation on the recovery attempt.`,
              { model: candidate.model, letter: candidate.letter, language: primaryLanguage });
            await addEvent(job.id, "info", "solver_done",
              `${candidate.model} returned Candidate ${candidate.letter} after code-format recovery.`,
              { model: candidate.model, letter: candidate.letter, hasFinal: true, recovered: true });
          } else {
            candidate.error = `${candidate.model}: no complete runnable ${primaryLanguage} code after recovery`;
            await addEvent(job.id, "warn", "solver_code_recovery_empty",
              `${candidate.model} still returned no complete runnable code; its answer will not be treated as a solution.`,
              { model: candidate.model, letter: candidate.letter, language: primaryLanguage });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          candidate.error = `${candidate.model}: code recovery failed: ${message}`;
          await addEvent(job.id, "warn", "solver_code_recovery_failed",
            `${candidate.model} could not complete the bounded code recovery request.`,
            { model: candidate.model, letter: candidate.letter, detail: message.slice(0, 240) });
        }
      }));
    }
  }

  // Ignore foreign-language candidate code during primary verification. The
  // source remains in the audit log; ports start only after the final winner.
  if (inferredKind === "code") {
    for (const candidate of candidates.filter(Boolean)) {
      if (candidate.final?.kind === "code" && (!candidate.final.wellFormed || !candidate.final.code?.trim())) {
        candidate.final = null;
        candidate.error ||= `${candidate.model}: incomplete code response; it was not sent to E2B.`;
      }
      if (candidate.final?.kind === "code" && candidateLanguage(candidate.final) !== primaryLanguage) {
        await addEvent(job.id, "warn", "non_primary_solution",
          "Candidate " + candidate.letter + " returned an incompatible first-stage language.",
          {letter:candidate.letter, model:candidate.model, expected:primaryLanguage}).catch(()=>{});
        candidate.final = null;
      }
    }
  }
  // Like the main-app preflight, Trusty works in parallel with the four
  // selected solvers but is joined before Council verification/review so its
  // independently E2B-tested answer can be included in the same judge docket.
  trustyCandidate = await trustyPromise;
  const answered = candidates.filter((candidate) => candidate?.text || candidate?.final);
  if (answered.length < 1 && !trustyCandidate) {
    const errors = candidates.filter(Boolean).map((candidate) => candidate.error || "").filter(Boolean);
    const quota = errors.find(isProviderQuotaError);
    const rateLimit = errors.find(isProviderRateLimit);
    if (quota || rateLimit) {
      const reason = quota
        ? `${gatewayId(settings)} cannot execute the configured Council models because its account is unavailable for billing or quota. Verify that gateway's payment/credit status, or select another gateway key in Settings.`
        : `${gatewayId(settings)} rate-limited every solver; the worker should retry later.`;
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
  if (trustyCandidate) field.push(trustyCandidate);

  const isCoding = inferredKind === "code" || looksLikeCodingProblem(field);
  if (isCoding && !field.some((candidate) => candidate.final?.kind === "code" && candidate.final.code?.trim())) {
    const reason = `No solver returned complete runnable ${primaryLanguage} code after recovery. E2B did not run; no solution was verified.`;
    await addEvent(job.id, "error", "coding_no_usable_solution", reason,
      { language: primaryLanguage, models: field.map((candidate) => candidate.model) });
    await patchJob(job.id, {
      status: "needs_attention",
      progress_phase: "needs_attention",
      error: reason,
      finished_at: new Date().toISOString(),
    });
    return;
  }

  // What kind of question was it? Asked of the answers, not of the picture: a
  // panel that came back with code has settled that more reliably than any
  // classifier run over the pixels beforehand could have.
  // Named here rather than at the end: the answers are in hand, and a run that
  // fails later should still have left a session you can recognise.
  // Naming is user-facing metadata, not a prerequisite for harness generation.
  // Start it now and join before the report is saved; a slow DB title lookup
  // must not hold up E2B preflight or model reviews.
  const sessionNaming = nameSessionFromWork(job, reading, field);

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
  // The same relevant documentation is available during reviews, revisions,
  // judges and synthesis, not only in the initial solve.
  const councilKnowledge = [initialReference.prompt,knowledge].filter(Boolean).join("\n\n");

  timer.enter("benchmark");
  const benchmark = await benchmarkCandidates(job, settings, baseUrl, models, judges, screenshotEvidence.question, field, knowledge, bench, {preparedSuites,eagerRuns,warmPool});
  // All original candidates have finished. Do not pay for standby capacity
  // throughout later reviews, judges or language porting.
  await warmPool?.close();
  warmPool = null;
  // When the contract lacked an explicit interface, testing followed the
  // candidate-aware path; still publish a provisional verified result before
  // starting the separate Council review/judging stages.
  if(!provisionalState.record){
    for(const candidate of field){
      await publishProvisional(candidate,benchmark.runs[candidate.letter]);
      if(provisionalState.record)break;
    }
  }
  // Checkpoint *every* independently submitted candidate, its parsed code,
  // and its actual E2B run before review, so a later judge/gateway outage
  // cannot erase the solver field from account-scoped database history.
  // The existing provisional row (when present) is never replaced with
  // unverified code; it stays the visible solution until a better one passes.
  await provisionalState.writing;
  const candidateCheckpoint = {
    stage: provisionalState.record ? "provisional" : "candidate_evidence",
    standing: provisionalState.record ? "provisional" : "unverified",
    winner: null,
    ...(provisionalState.record ? {
      provisional: provisionalState.record,
      solutionHistory: buildSolutionHistory(provisionalState.record,null),
    } : {}),
    synthesis:"Candidate solutions and their E2B evidence are saved; independent Council review and judging are still running.",
    candidates:field,reviews:[],judges:[],runs:benchmark.runs,
    revisedRuns:{},oracles:benchmark.oracles || [],ports:[],suites:benchmark.suites,
  };
  try {
    if(provisionalState.persisted) await updateSavedCouncilReport(job,candidateCheckpoint);
    else {
      await saveCouncilReport(job,candidateCheckpoint);
      provisionalState.persisted=true;
    }
    await addEvent(job.id,"info","candidate_evidence_saved",
      "Saved all model candidates and their E2B results before Council judging.",
      {candidates:field.length,tested:Object.values(benchmark.runs).filter(run=>run.ran).length});
  } catch(err) {
    await addEvent(job.id,"warn","candidate_evidence_save_failed",
      "Candidate checkpoint could not be stored; Council continues with its in-memory evidence.",
      {detail:String(err).slice(0,200)}).catch(()=>{});
  }
  const docket = candidateDocket(field);
  // An execution backend that is down makes every candidate "untested", which
  // reads exactly like every candidate being useless. It is not the same thing
  // and the record should not imply it is.
  const attempted = Object.values(benchmark.runs).filter((r) => r?.note && !r.ran);
  const infraFailures = attempted.filter((r) =>
    /sandbox|e2b|timed out|econn|network|unauthor|api key|rate limit/i.test(String(r.note))
  );
  const codeRuns = field.filter((candidate) => candidate.final?.kind === "code" && candidate.final.code?.trim())
    .map((candidate) => benchmark.runs[candidate.letter]).filter(Boolean);
  if (benchmark.suites.length && codeRuns.length && codeRuns.every((run) => !run.ran)) {
    const firstRunnerError = codeRuns.find((run) => run.note)?.note || "unknown runner failure";
    throw new Error(`E2B could not execute any candidate; no solution was tested. First runner error: ${firstRunnerError}`);
  }
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
  const harnessTrust = assessHarnessTrust(benchmark.suites, oracles);
  await addEvent(job.id, harnessTrust.risks.length ? "warn" : "info",
    "harness_trust_summary", harnessTrust.risks.length
      ? "Harness risks require independent review." : "No identified independent harness risks.",
    harnessTrust);
  // Strict mode is opt-in until representative Hobby E2B integration runs
  // prove the harness generators meet all independent reference requirements.
  if (isCoding) requireTrustedHarness(harnessTrust,
    process.env.CODE_AUDITOR_E2B_STRICT_ORACLE === "1");
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

  timer.enter("reviewing");
  await patchJob(job.id, { progress_phase: "reviewing" });

  const reviewSets = [];

  const verifiedCandidates=field.filter(c=>isVerified(benchmark.runs[c.letter]));
  await addEvent(job.id,"info","candidate_evidence",
    "E2B verified "+verifiedCandidates.length+" of "+field.length+" candidates.",
    {candidates:field.map(c=>({letter:c.letter,status:evidenceStatus(benchmark.runs[c.letter])}))});
  // Failed candidates need review most: the reviewers see their E2B case and
  // compiler evidence, give code-level guidance, then the solver revises and
  // E2B independently retests. Never skip this stage when zero candidates pass.
  const reviewing=bench.keep(models,(m)=>m.id);
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
          user: reviewUserPrompt({ question, docket, execution, knowledge: councilKnowledge }),
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
  // Repair genuine candidate failures as well as reviewer-raised concerns.
  // A test-failing solution gets at most three model repair generations, each
  // followed by the same E2B suite. Harness/setup failures remain excluded:
  // those are not defects the solver can responsibly repair.
  const revisionCandidates=field.filter(candidate=>{
    const run=benchmark.runs[candidate.letter];
    const reviewerFoundConcern=isVerified(run) && reviewsOf(reviewSets,candidate.letter).some(review=>
      review.correct==="no" || (review.correct==="unsure" &&
        !/^(none|no issue|n\/a|not applicable)$/i.test(String(review.problems||"").trim()))
    );
    return requiresRepair(run)||reviewerFoundConcern;
  });
  // Candidates are revised independently. Only a candidate still failing its
  // actual tests is asked again; reviewer-only concerns get one revision.
  if (revisionCandidates.length > 0) {
    timer.enter("revising");
    await patchJob(job.id, { progress_phase: "revising" });
    let active = bench.keep(
      revisionCandidates.filter((candidate) => candidate.final || candidate.text),
      (c) => c.model
    );
    await bench.announce("revising", field.filter((c) => bench.has(c.model)).map((c) => c.model));
    const originalRuns = benchmark.runs;
    let latestRuns = benchmark.runs;
    for (let attempt = 1; active.length && attempt <= MAX_CANDIDATE_REPAIR_ATTEMPTS; attempt += 1) {
      await addEvent(job.id, "info", "revising",
        `Repair attempt ${attempt} of ${MAX_CANDIDATE_REPAIR_ATTEMPTS} for ${active.length} candidate(s).`,
        { attempt, maxAttempts: MAX_CANDIDATE_REPAIR_ATTEMPTS,
          letters: active.map(candidate => candidate.letter), models: active.map(candidate => candidate.model) });
      const updated = new Map();
      await Promise.all(active.map(async (candidate) => {
        const current = field3.find(item => item.letter === candidate.letter) || candidate;
        const run = latestRuns[candidate.letter];
        const feedback = attempt === 1
          ? reviewsOf(reviewSets, candidate.letter).map((r) => `- [${r.reviewer}] correct: ${r.correct}. ${r.problems}`)
          : [];
        if (requiresRepair(run)) feedback.push(
          `- [TEST FAILURES — repair ${attempt}/${MAX_CANDIDATE_REPAIR_ATTEMPTS}] ${run.passed} passed, ${run.failed} failed. Untrusted E2B evidence:\n${executionFailureEvidence(run)}\nRepair the code, not the test harness. Preserve the original problem contract and callable interface.`
        );
        try {
          const revisionTrustyGateway = trustyGateway(settings);
          const revisionTrustyBase = gatewayBaseUrl({ gatewayId: revisionTrustyGateway });
          const revisionSettings = candidate.codingTrusty
            ? { ...settings, gatewayId: revisionTrustyGateway, gatewayBaseUrl: revisionTrustyBase, availableModels: [] }
            : settings;
          const revisionBaseUrl = candidate.codingTrusty ? revisionTrustyBase : baseUrl;
          const text = await tokenRouterGenerate({
            settings: revisionSettings, baseUrl: revisionBaseUrl, model: candidate.model,
            system: reviseSystemPrompt(),
            user: reviseUserPrompt({
              question, letter: candidate.letter,
              ownRaw: current.revised?.raw ?? current.final?.raw ?? current.revisedText ?? current.text,
              docket: candidateDocket(field3), received: feedback.join("\n"),
              execution: executionDigest(field3, latestRuns, { revised: attempt > 1 }),
              knowledge: councilKnowledge,
            }),
            maxTokens: Number(settings.maxTokens || 4096),
          });
          const parsed = parseFinal(text);
          const validRevision = Boolean(parsed?.wellFormed && parsed.kind !== "unknown" &&
            (current.final?.kind !== "code" || (parsed.kind === "code" && parsed.code.trim())));
          if (validRevision) updated.set(candidate.letter, { final: parsed, text });
          await addEvent(job.id, validRevision ? "info" : "warn",
            validRevision ? "revision_done" : "revision_unparsed",
            validRevision
              ? `${candidate.model} revised Candidate ${candidate.letter} (attempt ${attempt}/${MAX_CANDIDATE_REPAIR_ATTEMPTS}).`
              : `${candidate.model} revision ${attempt}/${MAX_CANDIDATE_REPAIR_ATTEMPTS} for Candidate ${candidate.letter} did not parse; the last valid candidate stands.`,
            { model: candidate.model, letter: candidate.letter, attempt,
              maxAttempts: MAX_CANDIDATE_REPAIR_ATTEMPTS });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await bench.note(candidate.model, err, "revising");
          await addEvent(job.id, "warn", "revision_failed",
            `${candidate.model} repair attempt ${attempt}/${MAX_CANDIDATE_REPAIR_ATTEMPTS} failed: ${message}`,
            { model: candidate.model, letter: candidate.letter, attempt,
              maxAttempts: MAX_CANDIDATE_REPAIR_ATTEMPTS });
        }
      }));

      if (!updated.size) {
        active = active.filter(candidate => requiresRepair(latestRuns[candidate.letter]));
        continue;
      }
      field3 = field3.map(candidate => {
        const revision = updated.get(candidate.letter);
        return revision ? { ...candidate, revised: revision.final, revisedText: revision.text } : candidate;
      });
      if (!benchmark.suites.length) break;
      timer.enter("reverifying");
      await patchJob(job.id, { progress_phase: "reverifying" });
      const toRetest = field3.filter(candidate => updated.has(candidate.letter));
      await addEvent(job.id, "info", "reverifying",
        `Re-running ${toRetest.length} revised candidate(s) against the same E2B tests.`,
        { attempt, letters: toRetest.map(candidate => candidate.letter) });
      const previousRuns = latestRuns;
      const attemptRuns = await executeField(job, settings, benchmark.suites, toRetest, { revised: true });
      latestRuns = { ...previousRuns, ...attemptRuns };
      revisedRuns = { ...revisedRuns, ...attemptRuns };
      for (const candidate of toRetest) {
        const before = previousRuns[candidate.letter] || originalRuns[candidate.letter];
        const after = attemptRuns[candidate.letter];
        const outcome = repairOutcome(before, after);
        await addEvent(job.id, outcome === "repaired" || outcome === "still_passing" ? "info" : "warn",
          "repair_outcome", `Candidate ${candidate.letter}: ${outcome} after repair attempt ${attempt}.`,
          { letter: candidate.letter, attempt, maxAttempts: MAX_CANDIDATE_REPAIR_ATTEMPTS,
            originalExecutionId: before?.executionId ?? null,
            revisedExecutionId: after?.executionId ?? null,
            outcome, originalPassed: before?.passed ?? 0,
            originalFailed: before?.failed ?? 0,
            revisedPassed: after?.passed ?? 0, revisedFailed: after?.failed ?? 0 });
      }
      const retestedLetters = new Set(toRetest.map(candidate => candidate.letter));
      const stillFailingRetests = toRetest.filter(candidate => requiresRepair(attemptRuns[candidate.letter]));
      const failedWithoutUsableRevision = active.filter(candidate =>
        !retestedLetters.has(candidate.letter) && requiresRepair(previousRuns[candidate.letter])
      );
      active = [...stillFailingRetests, ...failedWithoutUsableRevision];
      if (active.length && attempt === MAX_CANDIDATE_REPAIR_ATTEMPTS) {
        await addEvent(job.id, "warn", "repair_exhausted",
          `${active.length} candidate(s) still fail after ${MAX_CANDIDATE_REPAIR_ATTEMPTS} repair attempts. No failed revision will be marked verified.`,
          { attempts: MAX_CANDIDATE_REPAIR_ATTEMPTS, letters: active.map(candidate => candidate.letter) });
      }
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
    providedTestBrief(screenshotEvidence.fixtures),
    evidenceJudgeBrief(screenshotEvidence),
    revisedAny && Object.keys(revisedRuns).length
      ? `=== REVISED RUNS ===\n${executionDigest(field3, revisedRuns, { revised: true })}\n=== REPAIR OUTCOMES ===\n${field3.filter((c) => c.revised).map((c) => `Candidate ${c.letter}: ${repairOutcome(benchmark.runs[c.letter], revisedRuns[c.letter])}`).join("\\n")}\nA repair is verified only when its retest ran and passed actual test cases.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  timer.enter("judging");
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
            knowledge: councilKnowledge,
          }),
          // Only genuinely vision-probed judge routes see original pixels.
          // Evidence readers are model-ID strings, not objects with a .model.
          // Judges get original pixels only with a real successful image probe;
          // other judges still receive the transcription, samples and E2B runs.
          images: isVerifiedImageProbe(settings.probes?.[judge.model]) ? images : [],
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

  timer.enter("synthesizing");
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
        knowledge: councilKnowledge,
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
  timer.enter("final_gate");
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

  // Scoring is deterministic: execution gates correctness, independent code
  // audits can establish comparable Big O bounds, and measured performance
  // breaks remaining ties. Synthesis narrates the result.
  const decision = decideWinner({
    claimed,
    judges: judgeReadings,
    runs: gateRuns,
    letters: field3.map((c) => c.letter),
  });
  if (decision.winner) {
    const source = field3.find(candidate => candidate.letter === decision.winner);
    const final = source?.revised || source?.final;
    const execution = gateRuns[decision.winner];
    if (final?.kind === "code" && execution?.codeDigest &&
        createHash("sha256").update(final.code).digest("hex") !== execution.codeDigest) {
      throw new Error("Council refused to publish code that did not match its exact E2B-verified source.");
    }
  }
  if (isCoding && (!decision.winner || gateFor(gateRuns[decision.winner]) !== "pass")) {
    throw new Error("Council cannot publish a coding solution: no final candidate passed executable E2B test cases.");
  }
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

  const phaseTimings=timer.snapshot();
  let postJudgeUpgrade=null;
  await addEvent(job.id,"info","council_phase_timings","Council stage timing (milliseconds).",phaseTimings);
  const report = {
    phaseTimings,
    candidates: field3,
    suites: benchmark.suites,
    runs: benchmark.runs,
    revisedRuns,
    reviews: reviewSets,
    judges: judgeReports,
    // Stamped at the top, not appended at the bottom. A warning below a code
    // block is a warning nobody reads before copying the code block.
    synthesis: [
      decision.winner && standing.standing === "verified"
        ? `> **AUTHORITATIVE EXECUTION SELECTION: Candidate ${decision.winner}.** Copy only the selected candidate's tested code from the structured result. The synthesis text below is commentary and may name or rewrite a different candidate.\\n`
        : "",
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
    e2bEvidence: buildE2BEvidenceSummary({
      runs:gateRuns, suites:benchmark.suites, oracles, ports:[],
    }),
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
    ...(postJudgeUpgrade ? {postJudgeUpgrade} : {}),
  };
  // Built from the finished report rather than assembled alongside it, so the
  // helper overlay and the app render the same fields from the same source.
  report.presentation = buildPresentation(report);
  // Session title is optional metadata; it must not delay publishing an
  // already E2B-verified code answer.
  const availablePorts=secondaryCouncilLanguages(candidateLanguage(
    (field3.find(c=>c.letter===decision.winner)?.revised
      ||field3.find(c=>c.letter===decision.winner)?.final)||{}),
    settings.solutionLanguages);
  let source=field3.find(c=>c.letter===decision.winner);
  let verifiedSource=source?.revised||source?.final;
  const targets=(isCoding&&verifiedSource?.code&&isVerified(gateRuns[decision.winner]))
    ? availablePorts:[];
  // One reusable, readable translation brief for ALL target languages.
  // This uses the winning agent's existing explanation and extracts source
  // structure without a second model call or executing untrusted code.
  let semanticBlueprint=isCoding && verifiedSource?.code && isVerified(gateRuns[decision.winner])
    ? buildVerifiedSemanticBlueprint({
        source:verifiedSource,
        sourceLanguage:candidateLanguage(verifiedSource),
        sourceLetter:decision.winner,
        problem:question,
        passedTests:gateRuns[decision.winner]?.passed||0,
      })
    : null;
  if(semanticBlueprint){
    report.semanticBlueprint=semanticBlueprint;
    report.algorithmEvidence=buildAlgorithmEvidence(
      semanticBlueprint,gateRuns[decision.winner]);
  }
  report.ports=targets.map(language=>({
    language,sourceLetter:decision.winner,model:"",code:"",status:"preparing"
  }));
  // The preliminary code is immutable history, even when a later, better
  // judged solution supersedes it. The UI can show a literal line-level diff
  // and users can inspect/copy either version.
  await provisionalState.writing;
  report.stage="final";
  if(provisionalState.record){
    const early=provisionalState.record;
    const finalCode=verifiedSource?.code||"";
    report.provisional=early;
    report.solutionHistory=buildSolutionHistory(early,
      verifiedSource?.code ? {
        letter:decision.winner,language:candidateLanguage(verifiedSource),
        code:finalCode,complexity:report.presentation.complexity,
        passed:gateRuns[decision.winner]?.passed||0
      }:null);
    report.upgrade={
      changed: Boolean(finalCode && finalCode!==early.code),
      from:early.letter,to:decision.winner,
      reason:decision.disagreement||
        "The independent Council reviewed all passing candidates and selected the final verified solution.",
    };
  }
  const markdown = await saveCouncilReport(job, report, provisionalState.persisted);
  if(report.upgrade?.changed)await addEvent(job.id,"info","provisional_upgraded",
    "Council replaced provisional Candidate "+report.upgrade.from+
    " with final verified Candidate "+report.upgrade.to+".",
    {from:report.upgrade.from,to:report.upgrade.to,reason:report.upgrade.reason});
  // This saved report is already visible to the Mac UI while job.status is
  // still running. Translation is optional work, not an answer-delivery gate.
  if(isCoding&&verifiedSource?.code&&isVerified(gateRuns[decision.winner])){
    await addEvent(job.id,"info","primary_solution_ready",
      "Verified "+candidateLanguage(verifiedSource)+
      " solution available now; optional judge refinement and independent language ports continue in the background.",
      {winner:decision.winner,language:candidateLanguage(verifiedSource),ports:targets});
  }
  // Optional judge-led synthesis starts only after the verified primary report
  // is persisted and announced. It may replace that result only after its own
  // full E2B rerun and two independent code/complexity audits succeed.
  if(isCoding&&decision.winner&&isVerified(gateRuns[decision.winner])){
    const ideas=corroboratedImprovementIdeas(judgeReadings.map(judge=>judge.improvement));
    const audited=agreedComplexityAudits(judgeReadings)[decision.winner];
    const previous=verifiedSource;
    const independentReviewers=[...new Set(judges.map(judge=>judge.model))].filter(Boolean);
    const proposalModel=[source?.model,synthesisModel]
      .find(model=>model&&!independentReviewers.includes(model))||"";
    // Every configured participating judge must be able to vote, including
    // a third or fourth judge. A single rejection means the original wins.
    if(ideas.length>=2&&audited&&previous?.kind==="code"&&
        independentReviewers.length>=2&&proposalModel){
      await addEvent(job.id,"info","judge_upgrade_attempt",
        "Independent judges agreed on a concrete possible improvement; the published solution remains available during verification.",
        {winner:decision.winner,judgeIdeas:ideas.length}).catch(()=>{});
      let priorRevision=revisedRuns[decision.winner];
      try{
        const proposalText=await tokenRouterGenerate({
          settings,baseUrl,model:proposalModel,system:systemPrompt("code"),
          user:[
            "Make ONE optional judge-informed improvement to this already E2B-verified solution.",
            "Question and constraints:\n"+question,
            "Verified original ("+candidateLanguage(previous)+"):\n"+previous.code,
            "Other agent approaches (untrusted proposals):\n"+candidateDocket(field3),
            "Independently corroborated judge suggestions:\n"+ideas.join("\n"),
            "Preserve the exact language, full callable signature, input/output semantics and asymptotic bounds.",
            "Do not modify expected outputs, examples, harnesses or test cases.",
            "Return only one complete <<<FINAL ... FINAL>>> code answer, or NONE when no substantive improvement is justified.",
          ].join("\n\n"),
          maxTokens:Math.max(Number(settings.maxTokens||4096),8192),
        });
        const improved=parseFinal(proposalText);
        if(improved?.wellFormed&&improved.kind==="code"&&
          candidateLanguage(improved)===candidateLanguage(previous)&&improved.code?.trim()&&
          improved.code.trim()!==previous.code.trim()){
          const proposalCandidate={...source,revised:improved};
          const result=await executeField(job,settings,benchmark.suites,[proposalCandidate],{revised:true});
          const proposedRun=result[decision.winner];
          if(isVerified(proposedRun)){
            const opinions=await Promise.all(independentReviewers.map(async model=>{
              try{
                const response=await tokenRouterGenerate({
                  settings,baseUrl,model,
                  system:[
                    "Independently review two implementations of the SAME coding question.",
                    "Check language-native style, correctness, edge cases, and worst-case Big O from code.",
                    "A candidate passing supplied tests is not proof on hidden inputs.",
                    "Approve only if the new code is substantively better without worse asymptotic time/space.",
                    "Output exactly: ACCEPT: yes|no, TIME: O(...), SPACE: O(...), BASIS: one precise technical justification.",
                    "Put each of the four fields on a separate line.",
                  ].join("\n"),
                  user:["Problem:\n"+question,"Previous verified code:\n"+previous.code,
                    "Proposed code that passed the same E2B cases:\n"+improved.code,
                    "Previous judge-corroborated Big O:\nTIME: "+audited.time+"; SPACE: "+audited.space,
                    "E2B: "+proposedRun.passed+" tests passed; "+proposedRun.failed+" failed."].join("\n\n"),
                  maxTokens:1400,
                });
                return parseJudgeUpgradeVote(response);
              }catch{return {accepted:false,time:"",space:"",reason:"Independent reviewer unavailable"};}
            }));
            if(canAdoptJudgeUpgrade({priorRun:gateRuns[decision.winner],proposedRun,
              previousTime:audited.time,previousSpace:audited.space,approvals:opinions})){
              const originalField=field3;
              const originalRevisedRuns=revisedRuns;
              const originalRun=gateRuns[decision.winner];
              const originalBlueprint=semanticBlueprint;
              const originalPresentation=report.presentation;
              const originalEvidence=report.e2bEvidence;
              const originalAlgorithmEvidence=report.algorithmEvidence;
              const originalHistory=report.solutionHistory;
              const originalUpgrade=report.upgrade;
              field3=field3.map(candidate=>candidate.letter===decision.winner
                ?{...candidate,revised:improved}:candidate);
              source=field3.find(candidate=>candidate.letter===decision.winner);
              verifiedSource=source?.revised||source?.final;
              revisedRuns={...revisedRuns,[decision.winner]:proposedRun};
              gateRuns[decision.winner]=proposedRun;
              postJudgeUpgrade={beforeCode:previous.code,afterCode:improved.code,
                sourceLetter:decision.winner,model:synthesisModel,passed:proposedRun.passed,
                time:opinions[0].time,space:opinions[0].space,
                reason:"Two independent reviewers approved the judge-inspired, E2B-retested improvement."};
              semanticBlueprint=buildVerifiedSemanticBlueprint({source:verifiedSource,
                sourceLanguage:candidateLanguage(verifiedSource),sourceLetter:decision.winner,
                problem:question,passedTests:proposedRun.passed||0});
              report.candidates=field3;
              report.revisedRuns=revisedRuns;
              report.postJudgeUpgrade=postJudgeUpgrade;
              report.semanticBlueprint=semanticBlueprint;
              report.algorithmEvidence=buildAlgorithmEvidence(semanticBlueprint,proposedRun);
              report.e2bEvidence=buildE2BEvidenceSummary({runs:gateRuns,
                suites:benchmark.suites,oracles,ports:report.ports});
              report.presentation=buildPresentation(report);
              if(report.provisional){
                report.solutionHistory=buildSolutionHistory(report.provisional,{
                  letter:decision.winner,language:candidateLanguage(verifiedSource),
                  code:verifiedSource.code,complexity:report.presentation.complexity,
                  passed:proposedRun.passed||0});
                // The final winner may have originally matched the provisional
                // code; the later judge-approved E2B-tested patch is still a
                // real upgrade and must trigger the persisted overlay diff.
                report.upgrade={
                  ...(report.upgrade || {}),
                  changed:verifiedSource.code!==report.provisional.code,
                  from:report.provisional.letter,to:decision.winner,
                  reason:postJudgeUpgrade.reason,
                };
              }
              try{
                await updateSavedCouncilReport(job,report);
              }catch(persistError){
                field3=originalField;
                source=field3.find(candidate=>candidate.letter===decision.winner);
                verifiedSource=previous;
                revisedRuns=originalRevisedRuns;
                gateRuns[decision.winner]=originalRun;
                semanticBlueprint=originalBlueprint;
                postJudgeUpgrade=null;
                report.candidates=field3;
                report.revisedRuns=revisedRuns;
                delete report.postJudgeUpgrade;
                report.semanticBlueprint=originalBlueprint;
                report.presentation=originalPresentation;
                report.e2bEvidence=originalEvidence;
                if(originalAlgorithmEvidence)report.algorithmEvidence=originalAlgorithmEvidence;
                else delete report.algorithmEvidence;
                if(originalHistory)report.solutionHistory=originalHistory;
                else delete report.solutionHistory;
                if(originalUpgrade)report.upgrade=originalUpgrade;
                else delete report.upgrade;
                throw persistError;
              }
              await addEvent(job.id,"info","judge_upgrade_verified",
                "The judges' improvement passed E2B and both independent checks; the original version is retained for diff.",
                {winner:decision.winner,passed:proposedRun.passed});
            }else{
              if(priorRevision)revisedRuns={...revisedRuns,[decision.winner]:priorRevision};
              else{revisedRuns={...revisedRuns};delete revisedRuns[decision.winner];}
              await addEvent(job.id,"info","judge_upgrade_not_adopted",
                "The proposed improvement did not satisfy every independent audit; keeping the original verified solution.");
            }
          }else{
            if(priorRevision)revisedRuns={...revisedRuns,[decision.winner]:priorRevision};
            else{revisedRuns={...revisedRuns};delete revisedRuns[decision.winner];}
            await addEvent(job.id,"info","judge_upgrade_not_adopted",
              "The proposed improvement did not pass the complete accepted E2B test suite; keeping the original verified solution.");
          }
        }
      }catch(error){
        if(priorRevision)revisedRuns={...revisedRuns,[decision.winner]:priorRevision};
        else{revisedRuns={...revisedRuns};delete revisedRuns[decision.winner];}
        await addEvent(job.id,"warn","judge_upgrade_unavailable",
          "Optional judge improvement could not finish. The original verified solution remains available.",
          {detail:String(error).slice(0,300)}).catch(()=>{});
      }
    }
  }
  if(targets.length){
    try {
    await patchJob(job.id,{progress_phase:"porting"});
    // Only after the verified primary winner is available, optional language
    // Councils independently solve, verify, and judge from the original question.
    // Standby E2B sandboxes never allocate before primary result persistence.
    const portProblem = screenshotEvidence.question; // No previous winner or Python source is passed to secondary solvers.
    let portWarmPool = null;
    const portStandbyCount=standbyBudget(E2B_CAPACITY.snapshot(),targets.length);
    if (process.env.CODE_AUDITOR_E2B_PREWARM_PORTS === "1" &&
        portStandbyCount > 0 && secret("E2B_API_KEY")) {
      portWarmPool = createE2BWarmPool({
        idleMs:E2B_WARM_IDLE_MS,
        create: language => createE2BLease({
          executionId:executionId(), purpose:"standby-port-"+language,
          slot:language,jobId:job.id,
          timeoutMs:Math.max(REMOTE_RUN_TIMEOUT_MS + E2B_WARM_IDLE_MS + 60_000,180_000),
        }),
        destroy:async lease => {
          try { await lease.sandbox.kill(); }
          finally { lease.release(); }
        },
        onEvent:(name,meta) => addEvent(job.id,name==="failed"?"warn":"info",
          "e2b_port_prewarm_"+name,"Port sandbox "+name+" for "+meta.letter,meta).catch(()=>{}),
      });
      portWarmPool.prewarm(targets.slice(0,portStandbyCount));
    }
    try {
    let reportWrite=Promise.resolve();
    // Each language Council solves the original problem independently and
    // owns its own E2B execution leases. Run the Councils concurrently after
    // the primary result is durable; serialize report mutations so a faster
    // port cannot overwrite a slower port's result.
    await Promise.all(targets.map(async language => {
      await addEvent(job.id,"info","port_started",
        "Primary solution remains available. New independent Council: solving and verifying in "+language+".",
        {language,sourceLanguage:candidateLanguage(verifiedSource)}).catch(()=>{});
      // One secondary Council failure must never invalidate the published
      // primary winner or prevent the next independent language from solving.
      let port;
      try {
        port=await independentLanguageCouncil(job,settings,baseUrl,models,judges,
          portProblem,language,knowledge,bench,images,portWarmPool);
      } catch(error) {
        port={language,sourceLetter:decision.winner,model:"",code:"",
          status:"failed",error:String(error instanceof Error?error.message:error).slice(0,380)};
      }
      if (process.env.CODE_AUDITOR_E2B_DIFFERENTIAL === "1" && port.status === "verified") {
        port.differential=compareDifferentialTraces(
          gateRuns[decision.winner]?.stdout, port.run?.stdout);
        if (port.differential.status === "disagreement") {
          await addEvent(job.id,"warn","port_differential_disagreement",
            "Matching fixture inputs produced different outputs in "+language+".",
            {language,caseIds:port.differential.mismatches}).catch(()=>{});
          if (process.env.CODE_AUDITOR_E2B_DIFFERENTIAL_STRICT === "1") {
            port.status="failed";
            port.error="Cross-language differential disagreement on common fixtures";
            port.code="";
          }
        }
      }
      // Serialize JSONB report writes: concurrent port workers must not
      // overwrite each other's new verified code or failure status.
      reportWrite=reportWrite.catch(()=>{}).then(async()=>{
        report.ports=report.ports.map(item=>item.language===language?port:item);
        report.e2bEvidence=buildE2BEvidenceSummary({
          runs:gateRuns, suites:benchmark.suites, oracles, ports:report.ports,
        });
        try{
          await updateSavedCouncilReport(job,report);
        }catch(error){
          // The primary report has already been saved. Port report writes
          // are optional; a failed update cannot invalidate working code.
          await addEvent(job.id,"warn","port_save_failed",
            "Could not persist "+language+" port; primary verified solution remains available.",
            {language,error:String(error).slice(0,220)}).catch(()=>{});
        }
        await addEvent(job.id,port.status==="verified"?"info":"warn",
          port.status==="verified"?"port_verified":"port_failed",
          language+" "+(port.status==="verified"?"port passed E2B":"port could not be independently verified"),
          {language,status:port.status,sourceLetter:decision.winner,
           elapsedMs:port.run?.remoteElapsedMs??null,error:port.error||null}).catch(()=>{});
      });
      await reportWrite;
    }));
    await reportWrite;
    } finally {
      await portWarmPool?.close();
    }
    } catch(error) {
      await addEvent(job.id,"warn","optional_ports_unavailable",
        "Secondary implementations could not finish; the primary E2B-verified solution remains available.",
        {detail:String(error).slice(0,360)}).catch(()=>{});
    }
  }
  await sessionNaming;

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
  } finally {
    // Also disposes late-arriving E2B creates after a failed/cancelled job.
    await warmPool?.close();
  }
}

let preferBenchmark = true;
export async function tick() {
  const [benchmark, queued] = await Promise.all([nextQueuedBenchmark(), nextQueuedJob()]);
  if (benchmark && (!queued || preferBenchmark)) {
    preferBenchmark = false;
    await runQueuedBenchmark(benchmark);
    return true;
  }
  if (!queued) return false;
  preferBenchmark = true;
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
