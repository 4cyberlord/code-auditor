"use client";

import { create } from "zustand";
import {
  ALL_AGENTS,
  GATEWAY,
  gatewayPreset,
  STORAGE,
  PROVIDERS,
  PROVIDER_ORDER,
  TRANSCRIBER_LABEL,
  VISION_PROVIDERS,
  agentSpec,
  extraAgent,
  type AgentId,
  type GatewayId,
  type ProviderId,
  type TransportId,
} from "./models.ts";
import { normalizeMcqEndpoint, normalizeOverlayMode, type McqEndpoint, type OverlayMode } from "./mcq.ts";
import { parseFinal, type AgentFinal } from "./parse.ts";
import { computeConsensus, type ConsensusResult } from "./consensus.ts";
import {
  parseReview,
  reviewSystemPromptFor,
  reviewUserPromptFor,
  type PortLanguage,
  type SolutionReview,
} from "./review.ts";
import {
  systemPrompt,
  userPrompt,
  judgePromptWithKnowledge,
  imageManifest,
  solutionPolicy,
  type Mode,
} from "./prompts.ts";
import {
  EXTRACTION_SYSTEM,
  VISION_PREFERENCE,
  extractionUserPrompt,
  parseExtraction,
  compareExtractions,
  readingMarkdown,
  singleReading,
  tieBreakSystemPrompt,
  tieBreakUserPrompt,
  parseTieBreak,
  applyTieBreak,
  extractionFromOcr,
  ocrIsUsable,
  ocrUserPrompt,
  withOcrDoubt,
  OCR_STRUCTURE_SYSTEM,
  type OcrReading,
  type Extraction,
  type ExtractionAgreement,
} from "./extraction.ts";
import { routeProblem, reconcileProblemReadings, selectContractReaders, routeUnparsedProblem } from "./problemRouting.ts";
import { selectAdaptiveModels, selectAdaptiveJudges, type ModelCapability } from "./adaptiveModelRouting.ts";
import { captureNameOf } from "./image.ts";
import { planFor, needsExtraction, type ContextMode } from "./payload.ts";
import * as bridge from "./bridge.ts";
import * as db from "./sessions.ts";
import { detectZone, isUsableZone, formatWhen } from "./when.ts";
import { titleFor, placeholderTitle, isPlaceholder } from "./title.ts";
import { resolveAnswerLanguage } from "./answerLanguage.ts";
import { classifyProbeResult, isPermanentlyUnreachable, probeToastText } from "./probeFit.ts";
import { allKnowledgeRecords, knowledgePackFor, type KnowledgeRecord } from "./knowledge.ts";
import { blankDocument, markdownToRecord, recordToMarkdown, slugify } from "./knowledgeDoc.ts";
import { buildOverlayState } from "./overlayState.ts";
import {
  COUNCIL_DEFAULT_JUDGES,
  COUNCIL_DEFAULT_MODELS,
  COUNCIL_SIZE,
  councilMarkdown,
  councilFollowupSystemPrompt,
  councilFollowupUserPrompt,
  candidateDocket,
  candidateLanguage,
  endpointForCouncilModel,
  enforceWinnerGate,
  harnessIsSuspect,
  executionDigest,
  countCases,
  gateFor,
  judgeSystemPrompt,
  judgeUserPrompt,
  letterFor,
  parseReviewSet,
  parseTestSuites,
  parseCouncilSynthesis,
  parseJudgeReport,
  decideWinner,
  buildPresentation,
  mutateCode,
  oracleDigest,
  oracleSuspicion,
  contractSystemPrompt,
  contractUserPrompt,
  contractBlock,
  contractQuery,
  parseProblemContract,
  mergeProblemContracts,
  reviewSystemPrompt,
  reviewUserPrompt,
  reviseSystemPrompt,
  reviseUserPrompt,
  reviewsOf,
  spliceSuite,
  synthesisSystemPrompt,
  synthesisUserPrompt,
  testSpecSystemPrompt,
  testSpecUserPrompt,
  type Candidate,
  type CandidateRun,
  type CouncilPhase,
  type ContractAgreement,
  type CouncilDossier,
  type CouncilReport,
  type OracleSignal,
  type ProblemContract,
  type JudgeReport,
  type JudgeSeat,
  type CouncilModelSpec,
  type ReviewSet,
  type TestSuite,
} from "./council.ts";

/**
 * The drawers in the right-hand rail. "none" is a real choice — every drawer
 * shut, all the height to the panes.
 */
export const RAIL_PANELS = ["solution", "consensus", "jobs", "sessions", "history", "none"] as const;
export type RailPanel = (typeof RAIL_PANELS)[number];

export type AgentStatus = "idle" | "queued" | "streaming" | "done" | "error" | "cancelled";

export interface AgentSlot {
  id: string;
  provider: AgentId;
  model: string;
  enabled: boolean;
  status: AgentStatus;
  text: string;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number | null;
  startedAt: number | null;
  final: AgentFinal | null;
  /** The launch this pane is currently showing. Null when it has never run. */
  attemptId: string | null;
  /**
   * Whether this pane's answer came over the gateway. Shown on the pane, because
   * "which model said this" and "how did it get here" are different questions
   * and only one of them is written on the label.
   */
  viaGateway: boolean;
}

/** One agent's coalesced tokens for a single animation frame. */
export interface DeltaBatchEntry {
  agentId: string;
  attemptId: string;
  delta: string;
}

// ---------------------------------------------------------------- the council

/**
 * A seat on the council: one model asked for one extra piece of work (a review
 * pass, a revision, a verdict). Solving is not a seat — it is the panel itself,
 * which already exists and already streams into `agents`.
 *
 * These stream through the same Rust registry as the panes, guarded by
 * attemptId exactly as the panes are. Their `id`s are `council-*`, which the
 * pane reducers already decline to match, so a review's tokens can never land
 * in a solver's column or vice versa.
 */
export interface CouncilSlot {
  id: string;
  kind: "contract" | "solve" | "review" | "revise" | "judge";
  /** The model answering. Judges carry their emphasis along for the UI. */
  model: string;
  emphasis?: string;
  status: AgentStatus;
  text: string;
  error: string | null;
  attemptId: string | null;
  elapsedMs: number | null;
}

export interface CouncilChatMessage {
  id: string;
  role: "user" | "assistant";
  model: string | null;
  text: string;
  error: string | null;
  createdAt: number;
}

/** One record as the Knowledge workspace holds it: the file, and what it parses to. */
export interface KnowledgeEntry {
  /** The file stem, which is the record id. */
  id: string;
  /** The collection it sits in — a folder on disk, a heading in the sidebar. */
  category: string;
  markdown: string;
  path: string;
  updatedAt: number;
  record: KnowledgeRecord;
  problems: string[];
  /**
   * Where this record came from.
   *
   * "file" is yours, on disk, editable. "built-in" is the pack compiled into
   * this build: shown because a library that hides what it already knows looks
   * empty and is not, and written to disk the moment you edit one.
   */
  source: "file" | "built-in";
}

export interface KnowledgeState {
  entries: KnowledgeEntry[];
  /** Null until the folder has been read once. */
  folder: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Which record is open. "" means the draft is a new one. */
  selectedId: string;
  /** The editor's text. The file on disk is only what it was at last save. */
  draft: string;
  dirty: boolean;
  /** Set briefly after a save so the UI can say so without a toast. */
  savedAt: number | null;
  /** Publishing to the database the cloud worker reads. */
  syncing: boolean;
  syncedAt: number | null;
  /** What the last publish did, in one line. */
  syncNote: string;
}

export interface CouncilState {
  phase: CouncilPhase;
  runId: string | null;
  slots: CouncilSlot[];
  /** The anonymised field, built once solving settles. Letters index it. */
  candidates: Candidate[];
  /** Round 3's revisions, keyed by solver letter. */
  revisions: Record<string, { text: string; model: string } | undefined>;
  testSuites: TestSuite[];
  specBy: string | null;
  runs: Record<string, CandidateRun>;
  revisedRuns: Record<string, CandidateRun>;
  reviews: ReviewSet[];
  judges: JudgeReport[];
  synthesis: string;
  winner: string;
  /** The parsed dossier: the bench's own words, as fields a panel can render. */
  dossier: CouncilDossier | null;
  /** What the readers agreed the problem asks, before anybody answered it. */
  contract: ProblemContract | null;
  contractAgreement: ContractAgreement | null;
  /** Orthogonal checks on the harness itself. */
  oracles: OracleSignal[];
  error: string | null;
  chat: CouncilChatMessage[];
  chatSending: boolean;
}

const IDLE_KNOWLEDGE: KnowledgeState = {
  entries: [],
  folder: null,
  loading: false,
  saving: false,
  error: null,
  selectedId: "",
  draft: "",
  dirty: false,
  savedAt: null,
  syncing: false,
  syncedAt: null,
  syncNote: "",
};

const IDLE_COUNCIL: CouncilState = {
  phase: "idle",
  runId: null,
  slots: [],
  candidates: [],
  revisions: {},
  testSuites: [],
  specBy: null,
  runs: {},
  revisedRuns: {},
  reviews: [],
  judges: [],
  synthesis: "",
  winner: "",
  dossier: null,
  contract: null,
  contractAgreement: null,
  oracles: [],
  error: null,
  chat: [],
  chatSending: false,
};

/** Phases in which a council is mid-flight, for guards that park persistence. */
const COUNCIL_ACTIVE: CouncilPhase[] = [
  "contracting",
  "solving",
  "speccing",
  "verifying",
  "reviewing",
  "revising",
  "reverifying",
  "judging",
  "synthesizing",
];

const COUNCIL_STEP_MS = 500;

// ------------------------------------------------------------------- toasts

/** One transient notification. `sticky` toasts never auto-dismiss. */
export interface Toast {
  id: string;
  kind: "ok" | "warn" | "err";
  title: string;
  body: string;
  /** When set the toast stays until the user dismisses it. */
  sticky?: boolean;
}

let toastSeq = 0;

export interface ImageAsset {
  name: string;
  mime: string;
  /** base64 without the data: prefix */
  base64: string;
  dataUrl: string;
  bytes: number;
  /** 1 when it was sent untouched; below that, how much it was shrunk. */
  scale?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  /**
   * Set when this is one piece of a larger capture.
   *
   * A whole screen is cut into overlapping tiles rather than shrunk into
   * illegibility, so one keypress can produce several images. The panes receive
   * all of them; this is only so the thumbnail can say which is which.
   */
  tile?: { index: number; count: number; where: string };
  /** Shared by every piece of one capture, so pieces can be counted as one. */
  group?: string;
  /**
   * Where the capture was staged on this machine, if it came from one.
   *
   * A staging area, not a home: `screencapture` has to write a file because
   * there is no way to ask macOS for the bytes directly, and this is the path
   * deleted the moment the upload has a row behind it.
   */
  localPath?: string;
}

/**
 * Below this, text in a screenshot stops being reliably readable.
 *
 * Editor text is typically 13-14px. Shrunk by more than half it lands under
 * 7px, which is where a vision model starts guessing at glyphs rather than
 * reading them -- and guessing confidently, which is worse than failing.
 */
export const LEGIBLE_SCALE = 0.5;

export interface ExtractionReading {
  provider: ProviderId;
  extraction: Extraction;
}

export interface ExtractionState {
  status: "idle" | "running" | "done" | "error";
  readings: ExtractionReading[];
  agreement: ExtractionAgreement | null;
  /**
   * The rendered text handed to the agents. Kept so a single-pane retry reuses
   * the reading the rest of the panel got, instead of paying for a second vision
   * pass that could legitimately transcribe something slightly differently and
   * leave one pane answering a subtly different question.
   */
  context: string;
  /**
   * Where the reading was written to disk, once it has been.
   *
   * The document outlives the run, and that is deliberate: a transcription you
   * can open, read and correct by hand is the difference between a black box and
   * something debuggable. When a model answers the wrong question, this file is
   * where you find out whether the reader or the reasoner was at fault.
   */
  path: string | null;
  /**
   * Which images this reading is *of*.
   *
   * Without it, a reading made from three screenshots quietly survives a fourth
   * being pasted, and the panel answers a question the picture no longer asks.
   */
  for: string;
  error: string | null;
  /**
   * What happened when the transcriber was tried, when it was.
   *
   * Set only by `runOcrReading` in the *running* slot the fall-through resets.
   * `null` either means "on-device OCR read the screenshot" (this is how the
   * chip can tell provenance) or "reading hasn't run". The distinction between
   * those two is drawn by `status`, not by this field.
   */
  ocrNote: string | null;
}

const IDLE_EXTRACTION: ExtractionState = {
  status: "idle",
  readings: [],
  agreement: null,
  context: "",
  path: null,
  for: "",
  error: null,
  ocrNote: null,
};

/** Identifies a set of images, so a reading can be tied to the exact set. */
export const readingKey = (imgs: { name: string; group?: string }[]): string =>
  imgs.map((i) => i.group ?? i.name).join("\u0000");

interface JudgeState {
  status: "idle" | "running" | "done" | "error";
  provider: ProviderId;
  text: string;
  error: string | null;
}

interface Settings {
  mode: Mode;
  threshold: number;
  maxTokens: number;
  models: Record<ProviderId, string>;
  /** The same models addressed through the gateway, which namespaces by vendor. */
  routerModels: Record<ProviderId, string>;
  baseUrls: Record<ProviderId, string>;
  enabled: Record<AgentId, boolean>;
  judgeProvider: ProviderId;
  /**
   * When to adjudicate automatically. "prose" is the default because the lexical
   * comparison is weakest exactly where there is no code to compare.
   */
  autoJudge: "off" | "prose" | "always";
  /**
   * What the reasoning agents are given.
   *
   * "images"  — the picture, as it has always worked. Every agent does its own
   *             reading, so no single OCR mistake is shared.
   * "extract" — a cross-checked transcription and no picture. This is what lets
   *             a text-only model reachable through TokenRouter join the panel,
   *             and it is section 9's whole point.
   * "both"    — the picture and the reading. Costs the most, catches the most.
   *
   * Default is "images" because that is the path with a proven end-to-end run
   * behind it; "extract" is opted into, not defaulted into.
   */
  contextMode: ContextMode;
  /**
   * The models that read the screenshot.
   *
   * Two from different vendors makes a shared blind spot less likely, and their
   * disagreement is the only signal that a reading is wrong. One costs half the
   * requests and gives up that signal. Both are legitimate; the default is one,
   * because a request budget of five a minute makes the second reading expensive
   * in the currency that actually runs out.
   */
  extractors: ProviderId[];
  /**
   * Requests a minute the gateway key allows.
   *
   * Not discoverable from the API -- it is a property of the plan -- so it is a
   * number the user can set and that a 429 corrects downward on its own. Rust
   * holds the real governor; this is what it is told on startup.
   */
  gatewayPerMinute: number;
  /**
   * The zone every timestamp on screen is read in.
   *
   * Stored rather than detected fresh each time, so a session captured at home
   * still reads as home time when the laptop is somewhere else — history you
   * navigate by memory has to keep saying what you remember.
   */
  timeZone: string;
  /**
   * Whether the sessions drawer is open.
   *
   * It used to be a third column down the left, which cost the panes a fifth of
   * the window permanently to a list that is consulted occasionally. As a drawer
   * under the verdict it costs one row when shut.
   */
  /**
   * Which drawer in the right-hand rail is open. One at a time, by construction.
   *
   * Four independent booleans could all be true, and were: the rail then held
   * four expanded panels competing for one column, each squeezed to a strip.
   * A single value makes "only one is open" a property of the data rather than
   * a rule some future toggle can forget to apply.
   */
  /**
   * The application appearance mode: system (follows OS), light, or dark.
   */
  theme: "system" | "light" | "dark";
  railPanel: RailPanel;
  /** Whether the Solution read-out is expanded. Remembered between runs. */
  /**
   * Whether a capture pulls the window in front of whatever you were doing.
   *
   * Off, because the whole point of a global shortcut is that you do not have to
   * leave the thing you are looking at. The capture lands in the app either way;
   * this only decides whether the app interrupts you to say so.
   */
  raiseOnCapture: boolean;
  /** Images per run, 1..MAX_IMAGES. Every one is sent to every enabled agent. */
  maxImages: number;
  /** Which helper overlay workflow to use for background captures. */
  overlayMode: OverlayMode;
  /** Model id used for helper-only multiple-choice answers. */
  mcqModel: string;
  /** API surface used by the MCQ model; auto follows the roster/default route. */
  mcqEndpoint: McqEndpoint;
  /**
   * Whether to route through the gateway when a gateway key exists.
   *
   * Separate from "is there a key" so the router can be switched off for a run
   * without deleting the credential. When it is on and a key is saved, it wins:
   * every pane goes through it, including panes that also have a direct key.
   * One route for the whole panel is the property worth having -- a comparison
   * where two answers came over different wires is a comparison with an extra
   * variable in it.
   */
  useGateway: boolean;
  /** Which saved router supplies the credential and OpenAI-compatible wire. */
  gatewayId: GatewayId;
  /** The gateway's endpoint. Editable for self-hosted or regional routers. */
  gatewayBaseUrl: string;
  /**
   * Whether Run convenes the full council after the panel answers.
   *
   * Off by default, on purpose: a council run can cost thirty requests past the
   * panel itself, so it is a mode you choose, not a surprise you are billed
   * for. The council is a gateway feature — its seats are held by model id, not
   * by vendor key, so with the gateway off it cannot form.
   */
  councilEnabled: boolean;
  /**
   * The models that solve. Round 1 is still the visible panel; the panel's own
   * answers are always candidates, and this list is asked through the gateway
   * for the rest — silently skipping any the account is not entitled to rather
   * than failing the run over one unlisted model.
   */
  councilModels: CouncilModelSpec[];
  /**
   * The bench. Each judge reviews everything; the emphasis is only what it
   * pays extra attention to. Fewer than three judges is allowed and declared;
   * more than five is not.
   */
  councilJudges: JudgeSeat[];
  /**
   * The model that executes the final synthesis. Any id the gateway serves.
   * Empty means the first judge's model does it.
   */
  synthesisModel: string;
  /** Whether the panel's answers are also candidates in the council it feeds. */
  councilIncludePanel: boolean;
  /**
   * Who reads the screenshot.
   *
   *   "models" — two vision models look at the picture, with Apple Vision's
   *              text offered to them as a hint about characters
   *   "ocr"    — Apple Vision transcribes and a model structures that text,
   *              with nothing ever looking at the picture
   *
   * "models" by default. The two halves of reading are not equally served by
   * OCR: it turns pixels into characters better than a reasoning model does,
   * and it cannot see an indentation level, an axis, a diagram or a highlighted
   * line at all. On a screenshot of code or a chart, that second half is most
   * of the problem.
   */
  visionReaders: "models" | "ocr";
  /**
   * Whether two models read the problem into a contract before anyone solves it.
   *
   * On by default and worth its two calls: every later stage is handed the same
   * reading of the question, instead of each inheriting whichever restatement it
   * happened to be given.
   */
  councilProblemContract: boolean;
  /**
   * The language solutions come back in.
   *
   * Empty means "whatever the question was written in", which is the default:
   * someone who photographs a Python function wants Python back, and a correct
   * C++ rewrite answers a question they did not ask. Set it to force one
   * language regardless of the source.
   *
   * Separate from what the benchmark compiles. Timing a C++ build of the same
   * algorithm is evidence about the algorithm; it is not the deliverable.
   */
  outputLanguage: string;
  /**
   * Where generated candidate programs are actually executed.
   *
   * E2B is the default for cloud work because it keeps untrusted generated code
   * off the user's Mac while still returning timing and memory evidence.
   */
  executionProvider: "e2b" | "local";
  /** Wall-clock ceiling for one E2B command, after sandbox creation. */
  e2bTimeoutMs: number;
  /** Optional second-pass benchmark evidence after the fast E2B/local gate. */
  benchmarkBackend: "actions" | "off";
  /**
   * Every model id the router last said this key can reach.
   *
   * One listing call answers what used to take one probe request per model, and
   * answers it for the whole catalogue rather than only the seats already
   * filled. It is persisted so the Council can consult it without a round trip,
   * and refreshed whenever Settings is opened. Empty means "never asked" — not
   * "nothing available" — so an empty list never disqualifies anything.
   */
  availableModels: string[];
  /**
   * A running worker's tick endpoint, if there is one.
   *
   * The desktop app does not process cloud jobs — the worker is a separate Node
   * process holding its own gateway and database credentials. What the app can
   * do is ask it to take a job now instead of waiting out its poll interval, and
   * tell you when nothing is listening at all. Blank means no worker, which the
   * Background jobs panel reports rather than hides.
   */
  workerTickUrl: string;
  workerTickSecret: string;
  /**
   * How hard every model is asked to think before answering. "high" by default.
   *
   * A Council seat is not chatting — it is answering something four other models
   * and a bench of judges will pick apart, against a harness that runs its code.
   * A fast wrong answer is the expensive one: it still costs a review pass, a
   * judge pass and a benchmark run before anybody finds out it was wrong.
   * Routes with no reasoning mode are detected on first refusal and stop being
   * asked, so this costs nothing where it cannot be used.
   */
  reasoningEffort: "off" | "low" | "medium" | "high";
  /** Model id used by the Coding workspace. Empty means the first reachable active model. */
  codingModel: string;
  /** Project folder the Coding workspace can inspect and modify. */
  codingProjectRoot: string;
  /** Friendly project name shown in the Coding workspace instead of the full path. */
  codingProjectName: string;
  /** Output budget for each Coding workspace model turn. */
  codingMaxTokens: number;
  /** Sampling temperature for Coding workspace model turns. */
  codingTemperature: number;
  /** Whether the Coding workspace asks the selected model to think harder. */
  codingReasoning: boolean;
  /**
   * Which language to reach for when the question does not fix one, in order of
   * preference. A default, never an override: a screenshot showing a Python stub
   * still gets a Python answer, because that is the language it was asked in.
   */
  solutionLanguages: string[];
  /** The peak resident set a solution is asked to design toward, in KB. */
  memoryTargetKb: number;
  /**
   * Transcribe a screenshot into text before solving it.
   *
   * Off by default. The models that can be shown the picture solve from the
   * picture; the ones whose route cannot carry an image sit the round out. A
   * transcription is a lossy copy of the evidence, and spending two model calls
   * to make one — so that a model which cannot see can guess from it — buys less
   * than it costs. It turns itself back on for the one case where the
   * alternative is no answer at all: nothing on the bench can see.
   */
  transcribeScreenshots: boolean;
  /** `owner/repo` the benchmark workflow is dispatched to. */
  githubRepository: string;
  /** The workflow file, if it has been renamed. */
  githubWorkflow: string;
  /** The ref the workflow runs from. */
  githubRef: string;
  /** Wall-clock ceiling for one remote benchmark, dispatch and queue included. */
  benchmarkTimeoutMs: number;
  /**
   * What each model did when it was last actually asked something.
   *
   * Persisted with the rest of the settings so a test survives a restart. Keyed
   * by model id, not by pane: the same model can be a pane, the judge and a
   * reader at once, and it either works or it does not.
   */
  probes: Record<
    string,
    {
      ok: boolean;
      ms: number;
      error: string | null;
      at: number;
      /** Whether the model could read an attached image. Null when untested. */
      vision?: boolean | null;
      visionNote?: string | null;
    }
  >;
}

interface State {
  agents: AgentSlot[];
  images: ImageAsset[];
  note: string;
  runId: string | null;
  running: boolean;
  settings: Settings;
  settingsOpen: boolean;
  keys: Record<ProviderId, boolean>;
  /** Whether a gateway key is saved. One key, four panes. */
  gatewayKey: boolean;
  /** Whether a Supabase Storage key is saved. Where screenshots actually live. */
  storageKey: boolean;
  /** Transient notifications. */
  toasts: Toast[];
  /**
   * What happened to each image on its way to the project, by capture key.
   *
   * Visible rather than logged-and-forgotten: the upload is the one step in the
   * whole pipeline that happens silently in the background, and the promise it
   * carries — that the picture is somewhere other than this laptop — is exactly
   * the kind of promise that is discovered to be broken far too late.
   */
  uploads: Record<string, { state: "uploading" | "stored" | "failed"; why?: string }>;
  /** True while a capability test is in flight. */
  probing: boolean;
  probeError: string | null;
  judge: JudgeState;
  /** The council's progress and records. Idle unless the last run was one. */
  council: CouncilState;
  /** The knowledge library, as files in a folder you can open yourself. */
  knowledge: KnowledgeState;
  loadKnowledge: () => Promise<void>;
  importBundledKnowledge: () => Promise<void>;
  syncKnowledge: () => Promise<void>;
  selectKnowledge: (id: string) => void;
  newKnowledge: () => void;
  editKnowledge: (markdown: string) => void;
  saveKnowledge: () => Promise<void>;
  deleteKnowledge: (id: string) => Promise<void>;
  hydrated: boolean;
  /** Surfaced when a global shortcut or a screen capture could not be used. */
  shortcutError: string | null;

  /** Sessions in the sidebar, for whichever status is being shown. */
  sessions: db.Session[];
  sessionsStatus: "active" | "archived";
  /** The session captures attach to. Null when no database is configured. */
  currentSessionId: string | null;

  /** Past runs in this session, newest first. Empty until asked for. */
  history: db.RunSummary[];
  historyLoading: boolean;
  historyError: string | null;
  /**
   * The run the panes are currently showing, when it is not the live one.
   *
   * History is a *view*, not a destination: the live run is kept aside and put
   * back on exit, so opening an old answer never costs you the one on screen.
   */
  viewingRunId: string | null;
  loadHistory: () => Promise<void>;
  openRun: (runId: string) => Promise<void>;
  exitHistory: () => void;
  sessionsError: string | null;
  sessionsLoading: boolean;
  /** Guards against writing the same run to history twice. */
  runPersisted: boolean;

  /** The vision pass: what the screenshot says, before anyone reasons about it. */
  extraction: ExtractionState;

  hydrate: () => Promise<void>;
  refreshKeys: () => Promise<void>;
  /** Adds what fits under `MAX_IMAGES` and returns how many were turned away. */
  addImages: (imgs: ImageAsset[]) => number;
  removeImage: (index: number) => void;
  clearImages: () => void;
  setNote: (note: string) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  setSettingsOpen: (open: boolean) => void;
  /**
   * Open one drawer, closing whichever was open.
   *
   * Clicking the drawer that is already open shuts it, so the header stays a
   * toggle rather than becoming a one-way switch you cannot undo.
   */
  toggleRailPanel: (panel: RailPanel) => void;
  setShortcutError: (message: string | null) => void;

  loadSessions: (status?: "active" | "archived") => Promise<void>;
  newSession: (title?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** The session a capture should attach to, creating one if there is none. */
  ensureSession: () => Promise<string | null>;
  /**
   * Uploads screenshots to Supabase Storage and deletes the local copies.
   *
   * Fire-and-forget from the caller's point of view: a slow upload must never
   * delay the reading or the panel. What it guarantees is only that a row exists
   * for anything that uploaded successfully — and that the local file is gone
   * once that row does.
   */
  stashImages: (imgs: ImageAsset[]) => Promise<void>;
  /**
   * Names the session after whatever it turns out to be about.
   *
   * Only ever replaces a name the app itself invented. A title the user typed is
   * left alone, because an app that renames your work behind your back is an app
   * you stop trusting with it.
   */
  autoTitle: () => Promise<void>;
  /** Writes the finished run -- every answer plus the verdict -- to history. */
  persistRun: () => Promise<void>;

  /** Tries every model the app might ask for and records what came back. */
  testModels: (models: string[], testVision?: boolean) => Promise<void>;
  /**
   * Drops council seats the last probe proved this key cannot reach.
   *
   * Evidence-driven rather than a hardcoded list of retired ids: the roster is
   * free text and the catalogue changes under it, so the only durable answer to
   * "is this seat real" is what the gateway said last time we asked. Only the
   * two permanent reasons count — a rate-limited or slow model is the council
   * working against a small plan, and deleting a seat for that would shrink the
   * bench for a reason that had already passed.
   *
   * Returns what it removed, so the caller can say so rather than silently
   * editing a roster the user spent time on.
   */
  pruneUnreachableSeats: () => string[];
  /**
   * One probe result, applied the moment it arrives. Kept separate from the
   * batch in `testModels` on purpose: that one resolves last, this one keeps
   * the badges honest while it runs.
   */
  recordProbe: (r: bridge.ProbeResult) => void;

  /**
   * Reads the current images with the two extractors and compares them.
   * Resolves to null when there is nothing to read or nothing readable came
   * back — callers fall back to sending the images themselves.
   */
  runExtraction: () => Promise<ExtractionAgreement | null>;
  /**
   * Transcribes with Apple Vision (on-device, no key), then structures the text
   * with one model when a pane cannot see the picture. Returns null when the
   * pictures are not text — a diagram, a chart, a mockup — so the caller can
   * fall back to a model that can actually look at them, or when the engine
   * itself failed.
   */
  runOcrReading: (key: string) => Promise<ExtractionAgreement | null>;
  /** Apple Vision's text, for the models to check characters against. Never the reading itself. */
  ocrHintFor: (key: string) => Promise<string>;

  start: () => Promise<void>;
  cancel: () => Promise<void>;
  retry: (agentId: string) => Promise<void>;
  reset: () => void;

  appendDeltas: (batch: DeltaBatchEntry[]) => void;
  finishAgent: (e: bridge.DoneEvent) => void;
  failAgent: (e: bridge.ErrorEvent) => void;

  runJudge: () => Promise<void>;

  /**
   * The read-out on the solution the panel settled on: is it right, what is it
   * doing, could it be faster, is it written well — and the same algorithm in
   * C++, Rust and Python to compare.
   */
  review: {
    status: "idle" | "running" | "done" | "error";
    data: SolutionReview | null;
    error: string | null;
    /** Which port tab is showing. Sticky, so switching runs keeps your choice. */
    language: PortLanguage;
  };
  runReview: () => Promise<void>;
  setReviewLanguage: (lang: PortLanguage) => void;
  maybeAutoJudge: () => void;
  consensus: () => ConsensusResult;
  /** Fires the council once the panel has answered. No-op when disabled. */
  maybeStartCouncil: () => void;
  /** Continue the completed council discussion with one or more council models. */
  sendCouncilMessage: (message: string, models: string[]) => Promise<void>;
  /**
   * Push a notification onto the tray. `ok` toasts self-dismiss; errors stay
   * until the user reads them.
   */
  pushToast: (kind: Toast["kind"], title: string, body: string, opts?: { sticky?: boolean }) => void;
  dismissToast: (id: string) => void;
  /**
   * Writes the wire a model was discovered to speak back into settings, so a
   * `different endpoint` finding is a configuration change rather than a
   * repeated surprise. Re-probes the model immediately so the badge goes green
   * on its own instead of waiting for the user to press the button again.
   */
  setEndpointFor: (modelId: string, endpoint: "chat" | "responses") => void;
}

const STORAGE_KEY = "code-auditor.settings.v1";
const DB_SETTINGS_KEY = "app.v1";


/**
 * Images per run.
 *
 * Every one of these is sent to every enabled agent, so the payload is this
 * number times the number of panes -- ten images across four agents is forty
 * image uploads in one press. Worth knowing when a run costs more than expected.
 */
export const MAX_IMAGES = 10;

function publishOverlayState(s: State): void {
  const consensus = computeConsensus(
    s.agents
      .filter((a) => a.enabled && a.final)
      .map((a) => ({ id: a.id, name: agentSpec(a.provider).label, final: a.final! })),
    s.settings.threshold
  );
  void bridge.writeOverlayState(
    buildOverlayState({
      runId: s.runId,
      running: s.running,
      agents: s.agents,
      representative: consensus.representative ?? "",
      review: {
        status: s.review.status,
        data: s.review.data,
        language: s.review.language,
      },
      testSuites: s.council.testSuites,
      // Only a finished council has anything to present. Sending a half-built
      // one would put an "unverified" stamp on an answer that is still being
      // verified, which reads as a verdict rather than a progress state.
      presentation:
        s.council.phase === "done" ? buildPresentation(councilReportFrom(s.council)) : null,
      runs: s.council.runs,
    })
  );
}

const defaultSettings = (): Settings => ({
  mode: "auto",
  threshold: 0.55,
  maxTokens: 8192,
  models: Object.fromEntries(
    PROVIDER_ORDER.map((p) => [p, PROVIDERS[p].defaultModel])
  ) as Record<ProviderId, string>,
  routerModels: Object.fromEntries(
    PROVIDER_ORDER.map((p) => [p, PROVIDERS[p].defaultRouterModel])
  ) as Record<ProviderId, string>,
  baseUrls: Object.fromEntries(
    PROVIDER_ORDER.map((p) => [p, PROVIDERS[p].defaultBaseUrl])
  ) as Record<ProviderId, string>,
  // The four vendors on, the free extras off. Turning a pane on is a decision;
  // finding six panes you did not ask for is not.
  enabled: Object.fromEntries(
    ALL_AGENTS.map((a) => [a, !extraAgent(a)])
  ) as Record<AgentId, boolean>,
  judgeProvider: "anthropic",
  autoJudge: "prose",
  contextMode: "auto",
  gatewayPerMinute: 5,
  timeZone: detectZone(),
  // One reader, not two.
  //
  // Two independent readings cross-checked is the stronger design and it is
  // still available -- but every reading is a request, and against a budget of
  // five a minute the second one costs a pane. Claude reads screenshots most
  // reliably of the four, so when only one model can read, it is the one.
  extractors: ["anthropic"],
  theme: "system",
  railPanel: "consensus",
  raiseOnCapture: false,
  maxImages: MAX_IMAGES,
  overlayMode: "auto",
  mcqModel: "anthropic/claude-fable-5",
  mcqEndpoint: "auto",
  useGateway: true,
  gatewayId: GATEWAY.id,
  gatewayBaseUrl: GATEWAY.defaultBaseUrl,
  // On by default. The panel alone answers "did four models agree", which is a
  // weaker question than "does this run" — and runtime and memory only exist at
  // all when something executed the code.
  councilEnabled: true,
  councilModels: COUNCIL_DEFAULT_MODELS,
  councilJudges: COUNCIL_DEFAULT_JUDGES,
  synthesisModel: "openai/gpt-5.6-sol",
  councilIncludePanel: true,
  councilProblemContract: true,
  visionReaders: "models",
  outputLanguage: "",
  executionProvider: "e2b",
  e2bTimeoutMs: 120_000,
  // Off: the sandbox that runs a candidate already measures it. Switching this
  // to "actions" is an explicit choice to have GitHub do the measuring instead.
  benchmarkBackend: "off",
  availableModels: [],
  workerTickUrl: "",
  workerTickSecret: "",
  reasoningEffort: "high",
  codingModel: "",
  codingProjectRoot: "",
  codingProjectName: "",
  codingMaxTokens: 16384,
  codingTemperature: 0.2,
  codingReasoning: true,
  solutionLanguages: ["C++", "Python"],
  memoryTargetKb: 20 * 1024,
  transcribeScreenshots: false,
  githubRepository: "",
  githubWorkflow: "cloud-benchmark.yml",
  githubRef: "main",
  benchmarkTimeoutMs: 300_000,
  probes: {},
});

/**
 * A rerun reuses `runId` and `agentId`, so neither can say which launch an event
 * belongs to. Every launch mints one of these instead, and it is what the Rust
 * registry, the delta buffer and `isStale` all agree to key on.
 */
let attemptSeq = 0;
const newAttemptId = (): string =>
  `att-${Date.now().toString(36)}-${(attemptSeq++).toString(36)}`;

const freshAgent = (provider: AgentId, model: string, enabled: boolean): AgentSlot => ({
  id: provider,
  provider,
  model,
  enabled,
  status: "idle",
  text: "",
  error: null,
  inputTokens: null,
  outputTokens: null,
  elapsedMs: null,
  startedAt: null,
  final: null,
  attemptId: null,
  viaGateway: false,
});

/** The model id a pane would be asked for right now, whichever route it is on. */
export function modelLabelFor(id: AgentId, s: Settings): string {
  const extra = extraAgent(id);
  if (extra) return extra.model;
  return s.useGateway ? s.routerModels[id as ProviderId] : s.models[id as ProviderId];
}

const buildAgents = (s: Settings): AgentSlot[] =>
  ALL_AGENTS.map((a) => freshAgent(a, modelLabelFor(a, s), s.enabled[a]));

export const MAX_TOKENS_RANGE = { min: 512, max: 64000 } as const;
const THRESHOLD_RANGE = { min: 0.2, max: 0.9 } as const;

const clampTo = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;

/**
 * Remaps pane router-model IDs that were saved when they were the app default
 * but are no longer accessible on most standard TokenRouter keys.
 *
 * This runs on every settings load so a user who saved a stale id does not
 * have to hunt down a Settings field; it is fixed silently on the next launch.
 * The table maps old-id → replacement, verified against the TokenRouter
 * catalogue 2026-08-25. Only the per-provider pane ids are touched; the
 * council roster is a user choice and is left alone.
 */
const ROUTER_MODEL_MIGRATIONS: Partial<Record<string, string>> = {
  // claude-opus-5 was briefly the Anthropic pane default but most keys do not
  // have access to it. claude-opus-4.6 is the stable, broadly-entitled model.
  "anthropic/claude-opus-5":      "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-5-fast": "anthropic/claude-opus-4.8-fast",
  "anthropic/claude-sonnet-5":    "anthropic/claude-sonnet-4.6",
};

function migrateRouterModels(
  saved: Record<ProviderId, string>
): Record<ProviderId, string> {
  const defaults = defaultSettings().routerModels;
  const out = { ...defaults, ...saved };
  for (const [k, v] of Object.entries(out) as [ProviderId, string][]) {
    const replacement = ROUTER_MODEL_MIGRATIONS[v];
    if (replacement) out[k] = replacement;
  }
  return out;
}

/**
 * Persisted settings are whatever a previous build of the app wrote, so treat
 * them as untrusted. A stray `maxTokens: 0` reaches the provider as a request
 * for no output and comes back as an unexplained empty response; a threshold
 * outside the slider's range leaves the control stuck at one end.
 */
function normalizeSettings(s: Settings): Settings {
  const base = defaultSettings();
  return {
    ...s,
    mode: (["auto", "code", "research"] as const).includes(s.mode) ? s.mode : base.mode,
    autoJudge: (["off", "prose", "always"] as const).includes(s.autoJudge)
      ? s.autoJudge
      : base.autoJudge,
    judgeProvider: PROVIDER_ORDER.includes(s.judgeProvider) ? s.judgeProvider : base.judgeProvider,
    contextMode: (["auto", "images", "extract", "both"] as const).includes(s.contextMode)
      ? s.contextMode
      : base.contextMode,
    extractors: normalizeExtractors(s.extractors, base.extractors),
    // 1 is a legal budget and 600 is effectively none. Clamped rather than
    // trusted, because a saved zero would queue every request forever and look
    // exactly like the app hanging.
    gatewayPerMinute: Math.round(clampTo(s.gatewayPerMinute, 1, 600, base.gatewayPerMinute)),
    // A zone this machine's Intl cannot use would throw inside every render.
    timeZone: isUsableZone(s.timeZone) ? s.timeZone : base.timeZone,
    railPanel: RAIL_PANELS.includes(s.railPanel as RailPanel)
      ? (s.railPanel as RailPanel)
      : base.railPanel,
    theme: (["system", "light", "dark"] as const).includes(s.theme as "system")
      ? s.theme
      : base.theme,
    raiseOnCapture:
      typeof s.raiseOnCapture === "boolean" ? s.raiseOnCapture : base.raiseOnCapture,
    maxImages: Math.round(clampTo(s.maxImages, 1, MAX_IMAGES, base.maxImages)),
    overlayMode: normalizeOverlayMode(s.overlayMode),
    mcqModel:
      typeof s.mcqModel === "string" && s.mcqModel.trim()
        ? s.mcqModel.trim()
        : base.mcqModel,
    mcqEndpoint: normalizeMcqEndpoint(s.mcqEndpoint),
    useGateway: typeof s.useGateway === "boolean" ? s.useGateway : base.useGateway,
    // Older settings predate distinct gateway credentials. Infer Wiro from its
    // endpoint so an existing Wiro setup comes back as Wiro after upgrading.
    gatewayId:
      s.gatewayId === "wiro" ||
      (typeof s.gatewayBaseUrl === "string" && s.gatewayBaseUrl.includes("llm.wiro.ai"))
        ? "wiro"
        : GATEWAY.id,
    gatewayBaseUrl:
      typeof s.gatewayBaseUrl === "string" && s.gatewayBaseUrl.trim()
        ? s.gatewayBaseUrl.trim()
        : base.gatewayBaseUrl,
    councilEnabled: typeof s.councilEnabled === "boolean" ? s.councilEnabled : base.councilEnabled,
    councilIncludePanel:
      typeof s.councilIncludePanel === "boolean" ? s.councilIncludePanel : base.councilIncludePanel,
    councilProblemContract:
      typeof s.councilProblemContract === "boolean" ? s.councilProblemContract : base.councilProblemContract,
    visionReaders: s.visionReaders === "ocr" ? "ocr" : base.visionReaders,
    councilModels: normalizeCouncilModels(s.councilModels, base.councilModels),
    councilJudges: normalizeCouncilJudges(s.councilJudges, base.councilJudges),
    synthesisModel:
      typeof s.synthesisModel === "string" && s.synthesisModel.trim()
        ? s.synthesisModel.trim()
        : base.synthesisModel,
    threshold: clampTo(s.threshold, THRESHOLD_RANGE.min, THRESHOLD_RANGE.max, base.threshold),
    maxTokens: Math.round(
      clampTo(s.maxTokens, MAX_TOKENS_RANGE.min, MAX_TOKENS_RANGE.max, base.maxTokens)
    ),
    // Free text on purpose: the runner supports languages this app has never
    // been told about, and refusing an unrecognised one would be the app
    // deciding what counts as a language.
    outputLanguage:
      typeof s.outputLanguage === "string" ? s.outputLanguage.trim() : base.outputLanguage,
    executionProvider: (["e2b", "local"] as const).includes(
      s.executionProvider as "e2b"
    )
      ? s.executionProvider
      : base.executionProvider,
    e2bTimeoutMs: Math.round(clampTo(s.e2bTimeoutMs, 30_000, 300_000, base.e2bTimeoutMs)),
    availableModels: Array.isArray(s.availableModels)
      ? (s.availableModels as string[]).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
      : base.availableModels,
    workerTickUrl: typeof s.workerTickUrl === "string" ? s.workerTickUrl.trim() : base.workerTickUrl,
    workerTickSecret:
      typeof s.workerTickSecret === "string" ? s.workerTickSecret : base.workerTickSecret,
    reasoningEffort: (["off", "low", "medium", "high"] as const).includes(
      s.reasoningEffort as "high"
    )
      ? (s.reasoningEffort as Settings["reasoningEffort"])
      : base.reasoningEffort,
    codingModel: typeof s.codingModel === "string" ? s.codingModel.trim() : base.codingModel,
    codingProjectRoot:
      typeof s.codingProjectRoot === "string" ? s.codingProjectRoot.trim() : base.codingProjectRoot,
    codingProjectName:
      typeof s.codingProjectName === "string" ? s.codingProjectName.trim() : base.codingProjectName,
    codingMaxTokens: Math.round(
      clampTo(s.codingMaxTokens, MAX_TOKENS_RANGE.min, MAX_TOKENS_RANGE.max, base.codingMaxTokens)
    ),
    codingTemperature: clampTo(s.codingTemperature, 0, 2, base.codingTemperature),
    codingReasoning:
      typeof s.codingReasoning === "boolean" ? s.codingReasoning : base.codingReasoning,
    solutionLanguages:
      Array.isArray(s.solutionLanguages) && s.solutionLanguages.some((x) => typeof x === "string" && x.trim())
        ? (s.solutionLanguages as string[]).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
        : base.solutionLanguages,
    memoryTargetKb:
      typeof s.memoryTargetKb === "number" && Number.isFinite(s.memoryTargetKb) && s.memoryTargetKb > 0
        ? Math.round(s.memoryTargetKb)
        : base.memoryTargetKb,
    transcribeScreenshots:
      typeof s.transcribeScreenshots === "boolean" ? s.transcribeScreenshots : base.transcribeScreenshots,
    benchmarkBackend: (["actions", "off"] as const).includes(
      s.benchmarkBackend as "actions"
    )
      ? s.benchmarkBackend
      : base.benchmarkBackend,
    githubRepository:
      typeof s.githubRepository === "string" ? s.githubRepository.trim() : base.githubRepository,
    githubWorkflow:
      typeof s.githubWorkflow === "string" && s.githubWorkflow.trim()
        ? s.githubWorkflow.trim()
        : base.githubWorkflow,
    githubRef:
      typeof s.githubRef === "string" && s.githubRef.trim() ? s.githubRef.trim() : base.githubRef,
    // 30s is not enough for a cold runner to boot, install a toolchain and run;
    // 15 minutes matches the workflow's own timeout, past which waiting longer
    // only delays the report of a run that is already lost.
    benchmarkTimeoutMs: Math.round(
      clampTo(s.benchmarkTimeoutMs, 30_000, 900_000, base.benchmarkTimeoutMs)
    ),
    routerModels: migrateRouterModels(s.routerModels),
  };
}

/**
 * Two distinct vision-capable providers, or the defaults.
 *
 * A saved list can hold a provider that no longer exists, the same one twice, or
 * one whose default model cannot see. Any of those quietly turns the cross-check
 * into a single reading that still calls itself cross-checked, which is the one
 * outcome this whole mechanism exists to prevent.
 */
/**
 * Trusted council rosters from whatever a previous build wrote.
 *
 * A saved list can be empty, non-array, or hold numbers where model ids go;
 * any of those silently convenes a council of zero solvers, which produces a
 * report that says nothing while costing thirty requests to say it. Clamped to
 * the bench size for the same reason.
 *
 * Entries are objects, not strings, so an endpoint override can travel with
 * the id: {"id": "openai/gpt-5.3-codex", "endpoint": "responses"}. A plain
 * string is the same thing with the default wire.
 */
/**
 * Vendor prefixes that are permanently out of scope for this project.
 *
 * Any council solver or judge seat whose model id starts with one of these is
 * silently dropped when saved settings are loaded. The drop is permanent: the
 * seat is not replaced with a fallback, it is simply gone. If the removal
 * shrinks the roster below the minimum, `normalizeCouncilModels` falls back to
 * the default bench as it already does for any undersized saved list.
 */
const COUNCIL_MODEL_BLOCKLIST: readonly string[] = [
  "deepseek/",
  "qwen/",
];

const isBlocklisted = (modelId: string): boolean =>
  COUNCIL_MODEL_BLOCKLIST.some((prefix) => modelId.startsWith(prefix));

function normalizeCouncilModels(saved: unknown, fallback: CouncilModelSpec[]): CouncilModelSpec[] {
  if (!Array.isArray(saved)) return fallback;
  const out: CouncilModelSpec[] = [];
  const seen = new Set<string>();
  for (const raw of saved) {
    const spec =
      typeof raw === "string"
        ? { id: raw, endpoint: "chat" as const }
        : raw && typeof raw === "object"
          ? {
              id: String((raw as Record<string, unknown>).id ?? "").trim(),
              endpoint: ((raw as Record<string, unknown>).endpoint === "responses" ? "responses" : "chat") as "chat" | "responses",
            }
          : null;
    if (!spec || spec.id.length < 2 || seen.has(spec.id) || isBlocklisted(spec.id)) continue;
    seen.add(spec.id);
    out.push(spec);
  }
  if (out.length < COUNCIL_SIZE.solversMin) return fallback;
  return out.slice(0, COUNCIL_SIZE.solversMax);
}

function normalizeCouncilJudges(saved: unknown, fallback: JudgeSeat[]): JudgeSeat[] {
  if (!Array.isArray(saved)) return fallback;
  const emphases = new Set(["algorithms", "correctness", "performance", "engineering", "security"]);
  const clean = saved
    .map((j): JudgeSeat | null => {
      if (!j || typeof j !== "object") return null;
      const o = j as Record<string, unknown>;
      if (typeof o.model !== "string" || !o.model.trim()) return null;
      if (isBlocklisted(o.model.trim())) return null;
      return {
        model: o.model.trim(),
        emphasis: (emphases.has(String(o.emphasis)) ? o.emphasis : "correctness") as JudgeSeat["emphasis"],
      };
    })
    .filter((j): j is JudgeSeat => j !== null);
  if (clean.length < COUNCIL_SIZE.judgesMin) return fallback;
  return clean.slice(0, COUNCIL_SIZE.judgesMax);
}

function normalizeExtractors(saved: unknown, fallback: ProviderId[]): ProviderId[] {
  const list = Array.isArray(saved) ? saved : [];
  const clean = Array.from(
    new Set(list.filter((p): p is ProviderId => VISION_PROVIDERS.includes(p as ProviderId)))
  );
  // One is now a legitimate choice rather than a broken setting: it halves the
  // requests a run costs, which against a five-per-minute budget is the
  // difference between six panes answering and three of them 429ing. The
  // document says "single reader — no cross-check" so the trade is visible
  // wherever the reading is read.
  if (clean.length >= 1) return clean.slice(0, 2);
  for (const p of [...fallback, ...VISION_PROVIDERS]) {
    if (clean.length >= 1) break;
    if (!clean.includes(p)) clean.push(p);
  }
  return clean.slice(0, 2);
}

let settingsWriteSeq = 0;

function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  const base = defaultSettings();
  if (!saved) return base;
  return normalizeSettings({
    ...base,
    ...saved,
    models: { ...base.models, ...(saved.models ?? {}) },
    routerModels: { ...base.routerModels, ...(saved.routerModels ?? {}) },
    baseUrls: { ...base.baseUrls, ...(saved.baseUrls ?? {}) },
    enabled: { ...base.enabled, ...(saved.enabled ?? {}) },
    extractors: saved.extractors ?? base.extractors,
    probes: saved.probes ?? {},
  });
}

function loadCachedSettings(): Settings {
  const base = defaultSettings();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    return mergeSettings(JSON.parse(raw) as Partial<Settings>);
  } catch {
    return base;
  }
}

function saveCachedSettings(s: Settings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota: settings just won't persist */
  }
}

async function loadDbSettings(): Promise<Settings | null> {
  try {
    const saved = await bridge.settingsLoad<Partial<Settings>>(DB_SETTINGS_KEY);
    return saved ? mergeSettings(saved) : null;
  } catch {
    return null;
  }
}

async function saveDbSettings(s: Settings): Promise<void> {
  try {
    await bridge.settingsSave(DB_SETTINGS_KEY, s);
  } catch {
    // The cache already has the value. A missing or offline DB must not make
    // Settings feel broken; the next successful change will write it upstream.
  }
}

function applySettings(
  s: State,
  settings: Settings
): Pick<State, "settings" | "agents" | "judge"> {
  const agents = s.agents.map((a) =>
    a.status === "streaming" || a.status === "queued"
      ? a
      : {
          ...a,
          model:
            routeFor(a.provider, settings, s.keys, s.gatewayKey)?.model ??
            modelLabelFor(a.provider, settings),
          enabled: settings.enabled[a.provider],
        }
  );
  const judge =
    settings.judgeProvider !== s.settings.judgeProvider && s.judge.status !== "running"
      ? { status: "idle" as const, provider: settings.judgeProvider, text: "", error: null }
      : s.judge;
  return { settings, agents, judge };
}

/**
 * Where one pane's request should actually go.
 *
 * Every call that reaches a model -- the four panes, the two extractors, the
 * judge -- goes through here, so "am I on the router or direct?" is answered in
 * exactly one place. Four copies of this decision is how a run ends up with
 * three panes on the gateway and one quietly calling a vendor directly.
 *
 * `provider` is the *transport*: it selects the request shape and the Keychain
 * entry in Rust. `agentId` stays the pane's own id either way, which is what
 * keeps streamed tokens landing in the right column.
 */
export interface Route {
  provider: TransportId;
  model: string;
  baseUrl: string | null;
  /** True when this went through the gateway rather than straight to the vendor. */
  viaGateway: boolean;
}

/**
 * Wiro's gateway currently has no Moonshot/Kimi route. Keep this narrow and
 * explicit: a model is not rejected merely because it is absent from Wiro's
 * public listing, since team access is decided when it runs.
 */
const WIRO_UNAVAILABLE_MODELS = new Set(["moonshotai/kimi-k3"]);

function isPermanentGatewayFailure(error: string | null | undefined): boolean {
  const message = (error ?? "").toLowerCase();
  return (
    message.includes("model id is not available") ||
    message.includes("requested model was not found") ||
    message.includes("tool-not-accessible") ||
    message.includes("model catalog returned an invalid response")
  );
}

function unavailableWiroGatewayModel(model: string, s: Settings): boolean {
  if (s.gatewayId !== "wiro") return false;
  if (WIRO_UNAVAILABLE_MODELS.has(model)) return true;
  const probe = s.probes[model];
  return !!probe && !probe.ok && isPermanentGatewayFailure(probe.error);
}

function unavailableWiroModel(provider: AgentId, s: Settings): string | null {
  const model = s.routerModels[provider as ProviderId] || PROVIDERS[provider as ProviderId]?.defaultRouterModel;
  return model && unavailableWiroGatewayModel(model, s) ? model : null;
}

export function routeFor(
  provider: AgentId,
  s: Settings,
  keys: Record<ProviderId, boolean>,
  gatewayKey: boolean
): Route | null {
  // A router-only pane has no second way in. Without the gateway it is not
  // misconfigured, it simply cannot be reached, and says so.
  const extra = extraAgent(provider);
  if (extra) {
    if (!(s.useGateway && gatewayKey)) return null;
    return {
      provider: s.gatewayId,
      model: extra.model,
      baseUrl: s.gatewayBaseUrl || gatewayPreset(s.gatewayId).defaultBaseUrl,
      viaGateway: true,
    };
  }

  if (s.useGateway && gatewayKey) {
    if (unavailableWiroModel(provider, s)) return null;
    return {
      provider: s.gatewayId,
      model: s.routerModels[provider as ProviderId] || PROVIDERS[provider as ProviderId].defaultRouterModel,
      baseUrl: s.gatewayBaseUrl || gatewayPreset(s.gatewayId).defaultBaseUrl,
      viaGateway: true,
    };
  }
  // No gateway: a pane runs only if it has its own key. This is the case the
  // user described as "only that one would work" -- the others are not errors,
  // they simply have no way to reach anything.
  const p = provider as ProviderId;
  if (!keys[p]) return null;
  return {
    provider: p,
    model: s.models[p],
    baseUrl: s.baseUrls[p] || null,
    viaGateway: false,
  };
}

function endpointForModel(s: Settings, model: string): "chat" | "responses" {
  const id = model.trim();
  return endpointForCouncilModel(s.councilModels, id);
}

/**
 * Whether a pane can actually be shown a picture, measured where possible.
 *
 * `agentSpec().vision` is a table I wrote, and the table has already been wrong:
 * TokenRouter's own catalogue lists every model here as "Text" -- including the
 * two that read Charles's screenshots perfectly -- so that column describes what
 * a model outputs, not what it can be shown. Meanwhile Gemini, natively
 * multimodal everywhere else, had its connection dropped the moment an image
 * part was attached through this gateway. Neither fact is a property of the
 * model; both are properties of the route.
 *
 * So when the vision probe has actually sent a picture down this exact route and
 * seen what came back, that measurement wins. A pane the probe found blind then
 * gets the transcription instead of the image, automatically, which is the whole
 * reason the extraction pass exists.
 *
 * Only for gateway routes: a probe of TokenRouter says nothing about a direct
 * call to Anthropic, and quietly applying it there would be the same mistake in
 * the other direction.
 */
export function canSeeVia(agentId: AgentId, route: Route | null, s: Settings): boolean {
  const declared = agentSpec(agentId).vision;
  if (!route || !route.viaGateway) return declared;
  const measured = s.probes[route.model]?.vision;
  return measured == null ? declared : measured;
}

/**
 * Fetches one stored screenshot back, shaped like a freshly read capture.
 *
 * A signed URL rather than a public one, because the bucket is private: a
 * screenshot is whatever happened to be on screen when the shortcut was pressed,
 * and that is a far wider category than the code anyone meant to capture.
 *
 * Read into a data URL rather than pointed at directly, so the picture behaves
 * exactly like a pasted one everywhere downstream — the panel sends base64, and
 * a URL that expires in an hour is not something to hand a model.
 */
async function fetchStored(path: string, mime: string): Promise<{ dataUrl: string } | null> {
  try {
    const url = await bridge.signedUrl(path, 3600);
    const blob = await (await fetch(url)).blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    // Chunked: `String.fromCharCode(...bytes)` on a two-megabyte screenshot
    // exceeds the argument limit and throws.
    for (let i = 0; i < buf.length; i += 8192) {
      binary += String.fromCharCode(...buf.subarray(i, i + 8192));
    }
    return { dataUrl: `data:${mime || "image/png"};base64,${btoa(binary)}` };
  } catch {
    return null;
  }
}

/** The live run, kept aside while history is being read. Never rendered. */
let liveSnapshot: { agents: AgentSlot[]; note: string } | null = null;

/**
 * How long to wait for a pane that has not started before judging without it.
 *
 * Sized against the gateway's pacing rather than guessed: seats start roughly
 * one request apart, so the last of four can be a good few seconds behind the
 * first. Waiting costs nothing when nothing is pending.
 */
const LATE_STARTER_GRACE_MS = Number(process.env.NEXT_PUBLIC_LATE_STARTER_GRACE_MS) || 8000;

/**
 * How many times to come back before deciding without the late pane.
 *
 * Bounded on purpose. A pane can sit in "queued" and never leave it — a route
 * that never starts, a seat whose model was removed — and an unbounded wait for
 * one of those means the run is never judged, never reviewed and, worst of all,
 * never written to history. The original code carried a comment warning that
 * returning early from this function silently loses the run; waiting forever is
 * the same mistake wearing a timer.
 */
const LATE_STARTER_TRIES = 3;
let lateStarterCheck: ReturnType<typeof setTimeout> | null = null;
let lateStarterWaits = 0;

export const useStore = create<State>((set, get) => ({
  agents: buildAgents(defaultSettings()),
  images: [],
  note: "",
  runId: null,
  running: false,
  settings: defaultSettings(),
  settingsOpen: false,
  keys: Object.fromEntries(PROVIDER_ORDER.map((p) => [p, false])) as Record<ProviderId, boolean>,
  gatewayKey: false,
  storageKey: false,
  uploads: {},
  toasts: [],
  probing: false,
  review: { status: "idle", data: null, error: null, language: "cpp" },
  probeError: null,
  judge: { status: "idle", provider: "anthropic", text: "", error: null },
  council: IDLE_COUNCIL,
  knowledge: IDLE_KNOWLEDGE,
  hydrated: false,
  shortcutError: null,
  sessions: [],
  sessionsStatus: "active",
  currentSessionId: null,
  history: [],
  historyLoading: false,
  historyError: null,
  viewingRunId: null,
  sessionsError: null,
  sessionsLoading: false,
  runPersisted: false,
  extraction: IDLE_EXTRACTION,

  hydrate: async () => {
    const startedAtSeq = settingsWriteSeq;
    const settings = loadCachedSettings();
    set({
      settings,
      agents: buildAgents(settings),
      judge: { status: "idle", provider: settings.judgeProvider, text: "", error: null },
      hydrated: true,
    });
    // The governor lives in Rust and starts at its own default; a limit saved
    // last week has to be handed back on every launch or the first run of the
    // day is the one that 429s.
    void bridge.setGatewayRate(settings.gatewayPerMinute);

    const dbSettingsPromise = loadDbSettings().then((dbSettings) => {
      if (!dbSettings || settingsWriteSeq !== startedAtSeq) return;
      saveCachedSettings(dbSettings);
      set((s) => applySettings(s, dbSettings));
      void bridge.setGatewayRate(dbSettings.gatewayPerMinute);
    });

    await Promise.all([dbSettingsPromise, get().refreshKeys(), get().loadSessions("active")]);
  },

  refreshKeys: async () => {
    const [entries, gatewayKey, storageKey] = await Promise.all([
      Promise.all(PROVIDER_ORDER.map(async (p) => [p, await bridge.hasApiKey(p)] as const)),
      bridge.hasApiKey(get().settings.gatewayId),
      bridge.hasApiKey(STORAGE.id),
    ]);
    const keys = Object.fromEntries(entries) as Record<ProviderId, boolean>;
    // Relabel idle panes: whether the gateway key exists is what decides which
    // model id a pane is about to be asked for, and that is only known here.
    set((s) => ({
      keys,
      storageKey,
      gatewayKey,
      agents: s.agents.map((a) =>
        a.status === "streaming" || a.status === "queued"
          ? a
          : {
              ...a,
              model: routeFor(a.provider, s.settings, keys, gatewayKey)?.model ?? a.model,
            }
      ),
    }));
  },

  addImages: (imgs) => {
    // Counted in screenshots, not in images.
    //
    // A whole-screen capture becomes several tiles, and charging those against
    // the limit meant "10 images" silently became five screenshots -- and then
    // dropped half of the sixth, which is worse than refusing it.
    const current = get().images;
    const seen = new Set(current.map((i) => i.group ?? i.name));
    const room = Math.max(0, get().settings.maxImages - seen.size);

    const taken: ImageAsset[] = [];
    const admitted = new Set(seen);
    let refused = 0;
    for (const img of imgs) {
      const key = img.group ?? img.name;
      if (admitted.has(key)) {
        taken.push(img);
        continue;
      }
      if (admitted.size - seen.size < room) {
        admitted.add(key);
        taken.push(img);
      } else {
        refused += 1;
      }
    }
    void refused;
    // An image arriving is proof the capture path worked; drop any stale gripe.
    // A reading describes the exact set of images it was made from, so any change
    // to that set retires it rather than letting a later retry quote a
    // transcription of a picture that is no longer part of the question.
    if (taken.length) {
      set((s) => ({
        images: [...s.images, ...taken],
        shortcutError: null,
        extraction: IDLE_EXTRACTION,
      }));

      // The countermeasure, and the reason this fires here rather than at Run.
      //
      // A screenshot is a capability, not a message: it only reaches a model
      // whose route actually carries an image, and two of this app's routes
      // demonstrably do not. Text is not a capability. So the moment a picture
      // arrives it is converted into a document, and from then on the panel
      // depends on nothing but words.
      //
      // Starting now rather than at Run also buys the reading for free: it
      // happens while the user is still typing their note, so pressing Run does
      // not sit waiting on two vision calls that could have been made already.
      if (get().settings.contextMode !== "images") void get().runExtraction();

      // And the bytes go where they are meant to live. Not awaited: an upload
      // that takes a second must not hold up the reading or the panel, and the
      // only thing depending on it finishing is history.
      void get().stashImages(taken);
    }
    // Reported in screenshots too, so the message matches what was pressed.
    const wanted = new Set(imgs.map((i) => i.group ?? i.name)).size;
    const got = new Set(taken.map((i) => i.group ?? i.name)).size;
    return wanted - got;
  },
  removeImage: (index) =>
    set((s) => ({
      images: s.images.filter((_, i) => i !== index),
      extraction: IDLE_EXTRACTION,
    })),
  clearImages: () => set({ images: [], extraction: IDLE_EXTRACTION }),
  setNote: (note) => set({ note }),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  toggleRailPanel: (panel) =>
    get().patchSettings({ railPanel: get().settings.railPanel === panel ? "none" : panel }),
  setShortcutError: (shortcutError) => set({ shortcutError }),

  loadSessions: async (status) => {
    const next = status ?? get().sessionsStatus;
    set({ sessionsLoading: true, sessionsStatus: next });
    try {
      const sessions = await db.listSessions(next);
      set((s) => ({
        sessions,
        sessionsError: null,
        // Keep the selection only if it still exists in this list.
        currentSessionId: sessions.some((x) => x.id === s.currentSessionId)
          ? s.currentSessionId
          : next === "active"
            ? (sessions[0]?.id ?? null)
            : null,
      }));
    } catch (err) {
      // No database configured is the ordinary case before setup, not a fault
      // worth shouting about; anything else is worth showing.
      set({ sessions: [], sessionsError: cleanError(String(err)) });
    } finally {
      set({ sessionsLoading: false });
    }
  },

  newSession: async (title = "") => {
    try {
      const id = await db.createSession(title);
      await get().loadSessions("active");
      set({ currentSessionId: id, sessionsError: null });
      // A new session is a fresh start: nothing carried over from the last one.
      get().reset();
      set({ images: [], note: "" });
    } catch (err) {
      set({ sessionsError: cleanError(String(err)) });
    }
  },

  selectSession: async (id) => {
    const session = get().sessions.find((x) => x.id === id);
    set({ currentSessionId: id, note: session?.note ?? "", images: [] });
    get().reset();

    // Load what is actually in the session. Without this, switching sessions
    // shows an empty workspace whatever the sidebar says is in there.
    try {
      const stored = await db.listScreenshots(id);
      const assets: ImageAsset[] = [];
      for (const shot of stored) {
        if (shot.purged) continue;
        // From the project, not from this machine. The local file was deleted
        // the moment its row existed, which is exactly what makes a session
        // openable from a different device — the point of putting it there.
        const file = shot.storagePath
          ? await fetchStored(shot.storagePath, shot.mime)
          : shot.localPath
            ? await bridge.readCapture(shot.localPath)
            : null;
        // Gone from disk: the row stays, the picture does not. Skip it rather
        // than failing the whole session load for one missing file.
        if (!file) continue;
        assets.push({
          name: shot.fileName,
          mime: shot.mime,
          dataUrl: file.dataUrl,
          base64: file.dataUrl.slice(file.dataUrl.indexOf(",") + 1),
          bytes: shot.bytes,
        });
      }
      // Only apply if the user has not moved on while this was loading.
      if (get().currentSessionId === id)
        set({ images: assets.slice(0, get().settings.maxImages) });
    } catch (err) {
      set({ sessionsError: cleanError(String(err)) });
    }
  },

  renameSession: async (id, title) => {
    try {
      await db.updateSession(id, "title", title);
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
      }));
    } catch (err) {
      set({ sessionsError: cleanError(String(err)) });
    }
  },

  archiveSession: async (id, archived) => {
    try {
      await db.setSessionStatus(id, archived ? "archived" : "active");
      await get().loadSessions();
    } catch (err) {
      set({ sessionsError: cleanError(String(err)) });
    }
  },

  removeSession: async (id) => {
    try {
      await db.deleteSession(id);
      if (get().currentSessionId === id) set({ currentSessionId: null, images: [], note: "" });
      await get().loadSessions();
    } catch (err) {
      set({ sessionsError: cleanError(String(err)) });
    }
  },

  stashImages: async (imgs) => {
    if (!imgs.length || !get().storageKey) return;
    const sessionId = await get().ensureSession();
    if (!sessionId) return;

    const keyOf = (i: ImageAsset) => i.group ?? i.name;
    /** Local file -> whether every upload sourced from it has succeeded. */
    const survived = new Map<string, boolean>();

    set((st) => ({
      uploads: {
        ...st.uploads,
        ...Object.fromEntries(imgs.map((i) => [keyOf(i), { state: "uploading" as const }])),
      },
    }));

    for (const img of imgs) {
      try {
        const up = await bridge.uploadScreenshot({
          sessionId,
          fileName: img.name,
          mime: img.mime,
          data: img.base64,
        });
        await db.addScreenshot({
          sessionId,
          storageBucket: up.bucket,
          storagePath: up.path,
          fileName: img.name,
          bytes: up.bytes,
          mime: img.mime,
          width: img.sourceWidth ?? null,
          height: img.sourceHeight ?? null,
        });
        // Recorded, not acted on yet. One file can be the source of several
        // uploads, so whether it may be deleted is not knowable until every
        // piece that came from it is safely stored.
        if (img.localPath && !survived.has(img.localPath)) survived.set(img.localPath, true);
        set((st) => ({
          uploads: { ...st.uploads, [keyOf(img)]: { state: "stored" as const } },
        }));
      } catch (err) {
        // One screenshot failing to upload is not a reason to stop the panel
        // answering. It is a reason to say so, plainly, where it will be seen —
        // and to leave the local file alone, because it is now the only copy.
        if (img.localPath) survived.set(img.localPath, false);
        const why = cleanError(String(err));
        set((st) => ({
          sessionsError: why,
          uploads: { ...st.uploads, [keyOf(img)]: { state: "failed" as const, why } },
        }));
      }
    }

    // Now, and only for files every piece of which made it.
    //
    // This was inside the loop, and the trace log caught it: a whole-screen grab
    // becomes several tiles that all come from one file, so the first tile's
    // success deleted the file the remaining tiles were still being uploaded
    // from. It happened to work — the bytes are already in memory as base64 by
    // then — but it broke the rule that matters here, which is that the local
    // copy outlives every upload that depends on it. A failure on tile two would
    // have left no copy of anything.
    for (const [path, allStored] of survived) {
      if (allStored) void bridge.forgetLocalFile(path);
    }
  },

  autoTitle: async () => {
    const { currentSessionId, sessions, extraction, note } = get();
    if (!currentSessionId) return;
    const current = sessions.find((x) => x.id === currentSessionId);
    // A name the user chose outranks anything inferable.
    if (current && !isPlaceholder(current.title)) return;

    const suggested = titleFor({
      extraction: extraction.agreement?.merged ?? null,
      note,
    });
    if (!suggested || suggested === current?.title) return;
    try {
      await db.updateSession(currentSessionId, "title", suggested);
      await get().loadSessions(get().sessionsStatus);
    } catch {
      // A session that keeps its placeholder is a cosmetic problem, and this
      // runs on the way to an answer.
    }
  },

  ensureSession: async () => {
    const existing = get().currentSessionId;
    if (existing) return existing;
    try {
      // Titled by date, because a capture should never be blocked by a naming
      // prompt — and in the user's own zone, because a placeholder that says a
      // time they did not experience is worse than no time at all. Renamed by
      // `autoTitle` the moment the reading says what this is about.
      const when = formatWhen(Date.now(), get().settings.timeZone, "short");
      const id = await db.createSession(placeholderTitle(when));
      await get().loadSessions("active");
      set({ currentSessionId: id, sessionsError: null });
      return id;
    } catch {
      // No database yet: captures still work, they are just not persisted.
      return null;
    }
  },

  patchSettings: (patch) =>
    set((s) => {
      settingsWriteSeq += 1;
      const settings = normalizeSettings({ ...s.settings, ...patch });
      saveCachedSettings(settings);
      void saveDbSettings(settings);
      if (settings.gatewayPerMinute !== s.settings.gatewayPerMinute) {
        void bridge.setGatewayRate(settings.gatewayPerMinute);
      }
      // Model / enabled changes only apply to agents that aren't mid-flight.
      return applySettings(s, settings);
    }),

  reset: () =>
    set((s) => ({
      agents: buildAgents(s.settings),
      runId: null,
      running: false,
      council: IDLE_COUNCIL,
      judge: { status: "idle", provider: s.settings.judgeProvider, text: "", error: null },
      // The reading belonged to the images of the run being cleared. Keeping it
      // would let the next run inherit a transcription of a different picture.
      extraction: IDLE_EXTRACTION,
    })),

  recordProbe: (r) => {
    const probes = { ...get().settings.probes };
    const prior = probes[r.model];
    probes[r.model] = {
      ok: r.ok,
      ms: r.ms,
      error: r.error,
      at: Date.now(),
      vision: r.vision ?? prior?.vision ?? null,
      visionNote: r.visionNote ?? prior?.visionNote ?? null,
    };
    get().patchSettings({ probes });

    // The toast. A probe that told us nothing new (an ok result on a model
    // that was already ok this session) does not need a notification; one that
    // changed state, or failed, is the whole point of the tray.
    const was = prior?.ok ?? null;
    const changed = was !== r.ok;
    if (!changed && r.ok) return;
    const rep = classifyProbeResult(r.model, r.ok, r.error, r.ms);
    const toast = probeToastText(rep);
    get().pushToast(
      rep.status === "ok" ? "ok" : rep.status === "unsupported" ? "warn" : "err",
      toast.title,
      toast.body,
      { sticky: rep.status !== "ok" }
    );
  },

  /**
   * One-seat endpoint correction, written the moment the provider itself says
   * which wire the model speaks. Better once, in config, than on every probe.
   */
  setEndpointFor: (modelId: string, endpoint: "chat" | "responses") => {
    const settings = get().settings;
    const councilModels = settings.councilModels.map((m) =>
      m.id === modelId ? { ...m, endpoint } : m
    );
    get().patchSettings({ councilModels });
    // The probes for that model just changed meaning: the old "failed" belongs
    // to the wrong wire, and a fresh probe against the right one is owed.
    void get().testModels([modelId], false);
  },

  pushToast: (kind, title, body, opts) => {
    const id = `toast-${++toastSeq}`;
    set((s) => ({ toasts: [...s.toasts, { id, kind, title, body, sticky: opts?.sticky }] }));
    if (!opts?.sticky) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, 5200);
    }
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  pruneUnreachableSeats: () => {
    const { settings } = get();
    const gone = new Set<string>();
    for (const [model, p] of Object.entries(settings.probes)) {
      if (p.ok) continue;
      const { reason } = classifyProbeResult(model, false, p.error);
      if (isPermanentlyUnreachable(reason)) gone.add(model);
    }
    if (!gone.size) return [];

    const councilModels = settings.councilModels.filter((m) => !gone.has(m.id));
    const councilJudges = settings.councilJudges.filter((j) => !gone.has(j.model));
    // A synthesizer the key cannot reach is worse than none: the run would do
    // all its work and then fail on the last call. Falling back to a seat that
    // answered is better than leaving a hole.
    const synthesisModel = gone.has(settings.synthesisModel)
      ? councilModels[0]?.id ?? ""
      : settings.synthesisModel;

    get().patchSettings({ councilModels, councilJudges, synthesisModel });
    return [...gone].sort();
  },

  testModels: async (models, testVision = false) => {
    const { settings } = get();
    set({ probing: true, probeError: null });
    try {
      // Every model being probed, not just the roster ones.
      //
      // This used to map only `settings.councilModels`, which had two ways of
      // being wrong at once. A model that is a pane or a judge but not a roster
      // seat got no entry at all; and a *saved* roster entry with no `endpoint`
      // field fell back to "chat", which actively overrode what
      // `RESPONSES_MODELS` already knew. That is why `openai/gpt-5.3-codex`
      // came back "not supported in the v1/chat/completions endpoint" — the
      // app knew the right wire and then told Rust the wrong one.
      //
      // `endpointForModel` is the single place that answers this, and it
      // consults the roster *and* the known-Responses set. Asking it for every
      // model in the probe is the whole fix.
      const endpointByModel = Object.fromEntries(
        models.map((m) => [m, endpointForModel(settings, m)])
      );
      const results = await bridge.probeModels(
        models,
        settings.gatewayBaseUrl,
        settings.gatewayId,
        testVision,
        endpointByModel
      );
      const at = Date.now();
      const probes = { ...get().settings.probes };
      for (const r of results) {
        probes[r.model] = {
          ok: r.ok,
          ms: r.ms,
          error: r.error,
          at,
          // Kept from a previous run when this one did not ask, so switching the
          // vision test off does not erase what it found.
          vision: r.vision ?? probes[r.model]?.vision ?? null,
          visionNote: r.visionNote ?? probes[r.model]?.visionNote ?? null,
        };
      }
      get().patchSettings({ probes });
    } catch (err) {
      set({ probeError: cleanError(String(err)) });
    } finally {
      set({ probing: false });
    }
  },

  ocrHintFor: async (key) => {
    // Free, local, and about a millisecond of wall clock against a model call
    // that takes seconds — so it is worth having even when it is only used to
    // settle an l against a 1. A failure here is not a failure of the reading:
    // the models are looking at the picture either way.
    const { images } = get();
    if (!images.length || !bridge.inTauri()) return "";
    try {
      const pages = await bridge.ocrImages(images.map((i) => ({ mime: i.mime, data: i.base64 })));
      if (readingKey(get().images) !== key) return "";
      if (!pages.length) return "";
      return pages
        .map((p, i) => {
          const head = pages.length > 1 ? `--- OCR OF SCREENSHOT ${i + 1} ---` : "--- OCR TRANSCRIPTION ---";
          const unsure = p.unsure?.length ? `\n--- THE ENGINE WAS UNSURE OF THESE ---\n${p.unsure.map((u) => `- ${u}`).join("\n")}` : "";
          return `${head}\n${p.text.trim() || "(nothing legible)"}${unsure}`;
        })
        .join("\n\n");
    } catch {
      return "";
    }
  },

  runOcrReading: async (key) => {
    const { settings, images, note, keys, gatewayKey } = get();
    set({ extraction: { ...IDLE_EXTRACTION, status: "running", for: key } });

    let pages: OcrReading[];
    try {
      pages = await bridge.ocrImages(images.map((i) => ({ mime: i.mime, data: i.base64 })));
    } catch (err) {
      // A failed recognition pass is a real failure now, not a quota one. The
      // note stays on the extraction state so the user knows which path read
      // the screenshot -- or didn't -- and Vision-model fallback still works.
      set({
        extraction: {
          ...IDLE_EXTRACTION,
          status: "error",
          ocrNote: cleanError(String(err)),
        },
      });
      return null;
    }

    if (!ocrIsUsable(pages)) {
      // Not text: a diagram, a chart, a mockup. Nothing an OCR engine can help
      // with, so hand the picture to a model that can actually look at it. The
      // "not text" note is legible in the panel for the same reason a failed
      // key was.
      set({
        extraction: {
          ...IDLE_EXTRACTION,
          status: "idle",
          ocrNote: "Not a picture of text, so a vision model will read it.",
        },
      });
      return null;
    }

    // Structuring is what costs a gateway request, so it is only bought when
    // somebody actually needs it: a pane that cannot be shown the picture. When
    // every pane can see, the transcription still gets written to disk — it just
    // never has to be interpreted for anyone.
    const anyBlind = ALL_AGENTS.some(
      (p) =>
        settings.enabled[p] &&
        !canSeeVia(p, routeFor(p, settings, keys, gatewayKey), settings)
    );

    let merged = extractionFromOcr(pages);
    // Widened deliberately: it becomes "Apple Vision + Claude" when a model
    // interprets the transcription, and stays "Apple Vision" when nobody does.
    let readerLabel: string = TRANSCRIBER_LABEL;

    if (anyBlind) {
      const reader = settings.extractors[0] ?? "anthropic";
      const route = routeFor(reader, settings, keys, gatewayKey);
      if (route) {
        try {
          // A text request, not a vision one: no image tokens, and far quicker
          // than asking a model to look at the same picture again.
          const raw = await bridge.runOnce({
            runId: `ocr-${Date.now().toString(36)}`,
            agentId: `structure-${reader}`,
            attemptId: newAttemptId(),
            provider: route.provider,
            model: route.model,
            systemPrompt: OCR_STRUCTURE_SYSTEM,
            userText: ocrUserPrompt(pages, note),
            images: [],
            maxTokens: settings.maxTokens,
            temperature: 0,
            baseUrl: route.baseUrl,
          });
          const structured = parseExtraction(raw);
          if (structured) {
            // The engine's doubts go in first. They are measured; the model's
            // are self-reported, and self-reported doubt is the thing models are
            // reliably worst at.
            merged = withOcrDoubt(structured, pages);
            readerLabel = `${TRANSCRIBER_LABEL} + ${agentSpec(reader).label}`;
          }
        } catch (err) {
          // The transcription is still good. Losing the interpretation means a
          // blunter document, not a failed run.
          console.warn("Structuring the transcription failed:", cleanError(String(err)));
        }
      }
    }

    if (readingKey(get().images) !== key) return null;

    const agreement = singleReading(
      merged,
      readerLabel === TRANSCRIBER_LABEL
        ? "Apple Vision, raw text"
        : "Apple Vision, structured"
    );

    const markdown = readingMarkdown(merged, {
      readers: [readerLabel],
      agreement: null,
      manifest: imageManifest(images),
      at: new Date().toISOString(),
    });

    set({
      extraction: {
        status: "done",
        readings: [],
        agreement,
        context: markdown,
        path: null,
        for: key,
        error: null,
        ocrNote: null,
      },
    });

    void bridge
      .saveReading(markdown, captureNameOf(images))
      .then((path) => {
        set((st) =>
          st.extraction.for === key ? { extraction: { ...st.extraction, path } } : {}
        );
      })
      .catch(() => {});

    // Now that something knows what this is about, the session can be named it.
    void get().autoTitle();

    return agreement;
  },

  runExtraction: async () => {
    const { settings, images, note, keys, gatewayKey } = get();
    if (!images.length) {
      set({ extraction: IDLE_EXTRACTION });
      return null;
    }

    // The reading now starts when the picture arrives rather than when Run is
    // pressed, so by the time a run begins it is usually already here. Reading
    // the same images twice would cost two more calls and could legitimately
    // transcribe a character differently, leaving one pane answering a subtly
    // different question than its neighbours.
    const key = readingKey(images);
    const have = get().extraction;
    if (have.status === "done" && have.for === key) return have.agreement;
    if (have.status === "running" && have.for === key) return null;

    // On-device first, but no longer on-device *only*.
    //
    // The two halves of "read this screenshot" are not the same job. Turning
    // pixels into characters is transcription, and Apple Vision does it better
    // than a reasoning model, for free, offline and with no quota — it is the
    // engine behind Live Text. Deciding what the screen *is* — which line is
    // highlighted, what the diagram shows, where the indentation puts a block,
    // what the axis says — is comprehension, and the engine cannot do any of it.
    //
    // Letting OCR stand alone was fine for a stack trace and wrong for
    // everything this app is actually pointed at. So the transcription is kept
    // and handed to the models as a hint about characters, and the models look
    // at the picture themselves. `visionReaders: "ocr"` restores the old path
    // for anyone who wants the cheap one.
    if (settings.visionReaders === "ocr") {
      const done = await get().runOcrReading(key);
      if (done) return done;
    }
    const ocrHint = await get().ocrHintFor(key);

    const routes = settings.extractors
      .map((p) => [p, routeFor(p, settings, keys, gatewayKey)] as const)
      .filter((pair): pair is readonly [ProviderId, Route] => pair[1] !== null);

    if (!routes.length) {
      const names = settings.extractors.map((p) => PROVIDERS[p].vendor).join(" or ");
      set({
        extraction: {
          ...IDLE_EXTRACTION,
          status: "error",
          error: `Reading the screenshot needs a route to ${names} — either a ${GATEWAY.label} key, or a key for the vendor itself. Add one in Settings, or set Context to "Images" to have each agent read the picture itself.`,
        },
      });
      return null;
    }

    set({ extraction: { ...IDLE_EXTRACTION, status: "running", for: key } });

    const payload = images.map((i) => ({ mime: i.mime, data: i.base64 }));
    const runId = `extract-${Date.now().toString(36)}`;

    // Both readers go at once, and one failing does not take the other with it:
    // a single reading with its lack of cross-check declared is still worth more
    // than nothing.
    const settled = await Promise.all(
      routes.map(async ([provider, route]) => {
        try {
          const text = await bridge.runOnce({
            runId,
            agentId: `extract-${provider}`,
            attemptId: newAttemptId(),
            provider: route.provider,
            model: route.model,
            systemPrompt: EXTRACTION_SYSTEM,
            userText: extractionUserPrompt(note, imageManifest(images), ocrHint),
            images: payload,
            maxTokens: settings.maxTokens,
            temperature: 0,
            baseUrl: route.baseUrl,
          });
          const extraction = parseExtraction(text);
          if (!extraction) {
            return { provider, extraction: null, why: "did not return usable JSON" };
          }
          return { provider, extraction, why: "" };
        } catch (err) {
          return { provider, extraction: null, why: cleanError(String(err)) };
        }
      })
    );

    const readings: ExtractionReading[] = settled
      .filter((r) => r.extraction !== null)
      .map((r) => ({ provider: r.provider, extraction: r.extraction! }));
    const failures = settled.filter((r) => r.extraction === null);

    if (!readings.length) {
      const detail = failures
        .map((f) => `${agentSpec(f.provider).label}: ${f.why}`)
        .join("; ");
      set({
        extraction: {
          ...IDLE_EXTRACTION,
          status: "error",
          for: key,
          error: `Neither model could read the screenshot. ${detail}`,
        },
      });
      return null;
    }

    let agreement =
      readings.length >= 2
        ? compareExtractions(readings[0].extraction, readings[1].extraction)
        : singleReading(
            readings[0].extraction,
            failures.length
              ? `${agentSpec(failures[0].provider).label} ${failures[0].why}`
              : "one extractor configured"
          );

    // Two strong readers disagreeing about what is on the screen is the one
    // failure this whole pipeline cannot recover from later: everything
    // downstream is answering about text, and if the text is wrong the answer
    // is wrong no matter how good the bench is. The old rule picked whichever
    // reading claimed the higher confidence — a number a model writes about
    // itself. A third model that can see the picture is a better arbiter than
    // that, and it is asked about the disputed fields only.
    const disputed = agreement.conflicts.filter((c) => c.severity === "high");
    if (readings.length >= 2 && !agreement.agree && disputed.length) {
      const arbiter = settings.councilModels
        .map((m) => m.id)
        .find((id) => !readings.some((r) => routeFor(r.provider, settings, keys, gatewayKey)?.model === id));
      if (arbiter && (settings.useGateway ? gatewayKey : false)) {
        try {
          const text = await bridge.runOnce({
            runId: `tiebreak-${Date.now().toString(36)}`,
            agentId: "extract-tiebreak",
            attemptId: newAttemptId(),
            provider: settings.gatewayId,
            model: arbiter,
            systemPrompt: tieBreakSystemPrompt(),
            userText: tieBreakUserPrompt(disputed, imageManifest(images)),
            images: payload,
            maxTokens: Math.min(settings.maxTokens, 1024),
            temperature: 0,
            baseUrl: settings.gatewayBaseUrl || gatewayPreset(settings.gatewayId).defaultBaseUrl,
            endpoint: endpointForModel(settings, arbiter),
          });
          agreement = applyTieBreak(
            readings[0].extraction,
            readings[1].extraction,
            agreement,
            parseTieBreak(text, disputed.map((c) => c.field)),
            arbiter
          );
        } catch {
          // An arbiter that could not be reached leaves the conflict standing,
          // which is the honest outcome and the one the panel already knows how
          // to show.
        }
      }
    }

    // A newer paste while the readers were working retires this one. Without
    // this the slower of two reads wins by finishing last, and the panel is
    // handed a transcription of a screenshot the user already replaced.
    if (readingKey(get().images) !== key) return null;

    const markdown = readingMarkdown(agreement.merged, {
      readers: readings.map((r) => agentSpec(r.provider).label),
      agreement: readings.length >= 2 ? agreement : null,
      independentReadings: readings.map((r) => r.extraction),
      manifest: imageManifest(images),
      at: new Date().toISOString(),
    });

    set({
      extraction: {
        status: "done",
        readings,
        agreement,
        // The document *is* what the agents get. Saving one text and sending a
        // different one would mean the file on disk is not evidence of what was
        // actually asked, and the two would drift the first time either changed.
        context: markdown,
        path: null,
        for: key,
        error: null,
        // The two-model path always resets it: here the reading came from
        // models, not on-device OCR, and every reason the transcriber gave for
        // not being that path's reader is stale.
        ocrNote: null,
      },
    });

    // Written beside the capture it describes, and deliberately not awaited into
    // the critical path: a full disk must not stop the panel from answering.
    void bridge
      .saveReading(markdown, captureNameOf(images))
      .then((path) => {
        set((st) =>
          st.extraction.for === key ? { extraction: { ...st.extraction, path } } : {}
        );
      })
      .catch(() => {
        // The reading is in memory and already on its way to the models. Failing
        // to also keep a copy is not worth interrupting anyone over.
      });

    // Now that something knows what this is about, the session can be named it.
    void get().autoTitle();

    return agreement;
  },

  start: async () => {
    const { settings, images, note, keys, gatewayKey } = get();

    // One route per pane, decided once. A pane with no route is not an error
    // the user caused by pressing the wrong button -- it simply has no way to
    // reach a model, and says so in the pane rather than failing mid-stream.
    const routes = new Map<AgentId, Route>();
    for (const p of ALL_AGENTS) {
      if (!settings.enabled[p]) continue;
      const r = routeFor(p, settings, keys, gatewayKey);
      if (r) routes.set(p, r);
    }

    const active = [...routes.keys()];
    if (!active.length) {
      set({ settingsOpen: true });
      return;
    }
    if (!images.length && !note.trim()) return;

    const runId = `run-${Date.now().toString(36)}`;
    const attempts = Object.fromEntries(
      ALL_AGENTS.map((p) => [p, newAttemptId()])
    ) as Record<AgentId, string>;
    const sys = systemPrompt(
      settings.mode,
      resolveAnswerLanguage(settings.outputLanguage, get().extraction.agreement?.merged.language ?? "")
    );
    let knowledge = knowledgePackFor(note, 5);

    // A new run leaves history: the panes are about to be overwritten anyway,
    // and keeping a snapshot of an old run to "return" to would put stale
    // answers back on screen after a fresh one finished.
    liveSnapshot = null;
    // A fresh run gets a fresh patience budget, or a second run inherits an
    // exhausted one and never waits for its own late seat.
    lateStarterWaits = 0;
    if (lateStarterCheck) {
      clearTimeout(lateStarterCheck);
      lateStarterCheck = null;
    }

    set((s) => ({
      runId,
      running: true,
      runPersisted: false,
      viewingRunId: null,
      extraction: IDLE_EXTRACTION,
      council: IDLE_COUNCIL,
      judge: { status: "idle", provider: s.settings.judgeProvider, text: "", error: null },
      review: { status: "idle", data: null, error: null, language: s.review.language },
      agents: s.agents.map((a) => {
        const route = routes.get(a.provider);
        const spec = agentSpec(a.provider);
        if (!settings.enabled[a.provider]) {
          return { ...freshAgent(a.provider, modelLabelFor(a.provider, settings), false) };
        }
        if (!route) {
          const unavailable = unavailableWiroModel(a.provider, settings);
          return {
            ...freshAgent(a.provider, modelLabelFor(a.provider, settings), true),
            status: "error" as const,
            error: unavailable
              ? `${unavailable} is unavailable through Wiro, so it was not called. Choose another Wiro model for this pane, or use that provider's direct key.`
              : spec.routerOnly
              ? `${spec.label} is only reachable through ${GATEWAY.label}. Add a ${GATEWAY.label} key, or switch this pane off.`
              : `No route to ${spec.vendor}. Add a ${GATEWAY.label} key to reach every model with one credential, or a ${spec.vendor} key to reach just this one.`,
          };
        }
        return {
          ...freshAgent(a.provider, route.model, true),
          status: "queued" as const,
          startedAt: Date.now(),
          attemptId: attempts[a.provider],
          viaGateway: route.viaGateway,
        };
      }),
    }));
    publishOverlayState(get());

    // The vision pass, when asked for, happens before anyone reasons. The panes
    // sit at "queued" through it, which is the truth: they are waiting on the
    // reading, not on a model.
    // Demand-driven: the transcription only costs two extra calls when somebody
    // in the panel actually cannot see the picture.
    const anyBlind = active.some((p) => !canSeeVia(p, routes.get(p) ?? null, settings));
    let context = "";
    if (needsExtraction(settings.contextMode, images.length > 0, anyBlind)) {
      await get().runExtraction();

      // Extraction is slow enough that Stop is a real possibility during it, and
      // a run that was stopped must not then launch four requests.
      const now = get();
      if (!now.running || now.runId !== runId) return;
      // Read it back from the store rather than from the return value, so the
      // agents and the panel are quoting the same text by construction.
      context = now.extraction.context;
      knowledge = knowledgePackFor(`${note}\n\n${context}`, 5);
    }

    const allImages = images.map((i) => ({ mime: i.mime, data: i.base64 }));

    // Fire all of them at once; each streams back independently.
    await Promise.all(
      active.map(async (provider) => {
        const route = routes.get(provider)!;
        // Decided per pane rather than once for the run: the same screenshot is
        // the right thing to send a vision model and useless to send a text-only
        // one, and both are in the panel now.
        const plan = planFor({
          mode: settings.contextMode,
          canSee: canSeeVia(provider, route, settings),
          hasImages: images.length > 0,
          context,
        });
        try {
          await bridge.runAgent({
            runId,
            agentId: provider,
            attemptId: attempts[provider],
            provider: route.provider,
            model: route.model,
            systemPrompt: sys,
            // The manifest goes with the pictures: which screenshot each image
            // belongs to, in the order they were taken. Without it a model gets
            // seven pictures and has to guess whether they are seven problems,
            // one problem seven times, or one screen in seven pieces.
            userText: userPrompt(
              note,
              plan.sendImages && images.length > 0,
              plan.context,
              plan.sendImages ? images : [],
              knowledge
            ),
            images: plan.sendImages ? allImages : [],
            maxTokens: settings.maxTokens,
            temperature: 0,
            baseUrl: route.baseUrl,
            // The pane's own override column in Settings carries the wire for a
            // model like codex — probing it on chat-completions was the exact
            // failure the classifier is built to fix.
            endpoint: endpointForModel(settings, route.model),
          });
        } catch (err) {
          get().failAgent({
            runId,
            agentId: provider,
            attemptId: attempts[provider],
            message: String(err),
          });
        }
      })
    );
  },

  cancel: async () => {
    const { runId, council } = get();
    if (runId) await bridge.cancelRun(runId);
    if (council.runId && council.runId !== runId) await bridge.cancelRun(council.runId);
    set((s) => ({
      running: false,
      council:
        s.council.phase === "idle"
          ? s.council
          : {
              ...s.council,
              phase: "cancelled" as const,
              slots: s.council.slots.map((x) =>
                x.status === "streaming" || x.status === "queued"
                  ? { ...x, status: "cancelled" as const }
                  : x
              ),
            },
      agents: s.agents.map((a) =>
        a.status === "streaming" || a.status === "queued"
          ? { ...a, status: "cancelled" as const, final: parseFinal(a.text) }
          : a
      ),
    }));
    publishOverlayState(get());
  },

  retry: async (agentId) => {
    const { settings, images, note, runId, keys, gatewayKey, extraction } = get();
    const provider = agentId as AgentId;
    const route = routeFor(provider, settings, keys, gatewayKey);
    if (!route) {
      set({ settingsOpen: true });
      return;
    }
    const id = runId ?? `run-${Date.now().toString(36)}`;
    // The run id is deliberately reused so Stop still sweeps the whole run by
    // prefix; the attempt id is what separates this launch from the last one.
    const attemptId = newAttemptId();
    // Re-running one pane is a fresh wait for that pane, so it does not inherit
    // a patience budget the previous run already spent.
    lateStarterWaits = 0;
    if (lateStarterCheck) {
      clearTimeout(lateStarterCheck);
      lateStarterCheck = null;
    }
    set((s) => ({
      runId: id,
      running: true,
      agents: s.agents.map((a) =>
        a.id === agentId
          ? {
              ...freshAgent(provider, route.model, true),
              status: "queued" as const,
              startedAt: Date.now(),
              attemptId,
              viaGateway: route.viaGateway,
            }
          : a
      ),
    }));
    publishOverlayState(get());
    // Reuse the reading the rest of the panel was given rather than extracting
    // again: a second vision pass could transcribe slightly differently, and this
    // pane's answer would then be to a subtly different question than its
    // neighbours' -- which would show up in the consensus as a real disagreement.
    const plan = planFor({
      mode: settings.contextMode,
      canSee: canSeeVia(provider, route, settings),
      hasImages: images.length > 0,
      context: extraction.context,
    });
    const knowledge = knowledgePackFor(`${note}\n\n${extraction.context}`, 5);

    try {
      await bridge.runAgent({
        runId: id,
        agentId,
        attemptId,
        provider: route.provider,
        model: route.model,
        systemPrompt: systemPrompt(
          settings.mode,
          resolveAnswerLanguage(settings.outputLanguage, get().extraction.agreement?.merged.language ?? "")
        ),
        userText: userPrompt(
          note,
          plan.sendImages && images.length > 0,
          plan.context,
          plan.sendImages ? images : [],
          knowledge
        ),
        images: plan.sendImages ? images.map((i) => ({ mime: i.mime, data: i.base64 })) : [],
        maxTokens: settings.maxTokens,
        temperature: 0,
        baseUrl: route.baseUrl,
        endpoint: endpointForModel(settings, route.model),
      });
    } catch (err) {
      get().failAgent({ runId: id, agentId, attemptId, message: String(err) });
    }
  },

  appendDeltas: (batch) =>
    set((s) => {
      const next = {
        agents: s.agents.map((a) => {
        // Tokens from a superseded launch reach us for as long as it takes the
        // cancel to land; matching on the attempt drops them instead of
        // splicing them into whatever the pane is showing now.
        const entry = batch.find((e) => e.agentId === a.id && e.attemptId === a.attemptId);
        if (!entry || !entry.delta) return a;
        // A pane the user stopped, or one that already errored, must not be
        // pulled back into "streaming" by tokens still in flight behind it.
        if (a.status !== "queued" && a.status !== "streaming") return a;
        return { ...a, status: "streaming" as const, text: a.text + entry.delta };
        }),
      };
      publishOverlayState({ ...s, ...next });
      return next;
    }),

  finishAgent: (e) => {
    const s0 = get();
    const slot = s0.council.slots.find((x) => x.attemptId === e.attemptId);
    if (slot) {
      if (isStaleCouncil(s0, slot, e.attemptId)) return;
      set((s) => {
        const slots = s.council.slots.map((x) =>
          x.id === slot.id
            ? { ...x, status: "done" as const, text: e.text || x.text, elapsedMs: e.elapsedMs }
            : x
        );
        // A revision belongs to the letter it revised, not just to its slot:
        // the verify-2 pass and every downstream prompt read it from there.
        const letter = slot.id.startsWith("council-revise:") ? slot.id.slice("council-revise:".length) : null;
        const revisions = letter
          ? { ...s.council.revisions, [letter]: { text: e.text || slot.text, model: slot.model } }
          : s.council.revisions;
        return { council: { ...s.council, slots, revisions } };
      });
      return;
    }
    if (isStale(s0, e)) return;
    set((s) => {
      const agents = s.agents.map((a) =>
        a.id === e.agentId
          ? {
              ...a,
              // Trust the server's full text over the accumulated deltas.
              text: e.text || a.text,
              status: "done" as const,
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              elapsedMs: e.elapsedMs,
              final: parseFinal(e.text || a.text),
            }
          : a
      );
      const stillGoing =
        agents.some((a) => a.status === "streaming" || a.status === "queued") ||
        COUNCIL_ACTIVE.includes(s.council.phase);
      const next = { agents, running: stillGoing };
      publishOverlayState({ ...s, ...next });
      return next;
    });
    get().maybeAutoJudge();
    get().maybeStartCouncil();
  },

  failAgent: (e) => {
    const s0 = get();
    const slot = s0.council.slots.find((x) => x.attemptId === e.attemptId);
    if (slot) {
      if (isStaleCouncil(s0, slot, e.attemptId)) return;
      if (s0.settings.gatewayId === "wiro" && isPermanentGatewayFailure(e.message)) {
        const probes = {
          ...s0.settings.probes,
          [slot.model]: {
            ok: false,
            ms: 0,
            error: cleanError(e.message),
            at: Date.now(),
            vision: s0.settings.probes[slot.model]?.vision ?? null,
            visionNote: s0.settings.probes[slot.model]?.visionNote ?? null,
          },
        };
        get().patchSettings({ probes });
      }
      set((s) => ({
        council: {
          ...s.council,
          slots: s.council.slots.map((x) =>
            x.id === slot.id
              ? { ...x, status: "error" as const, error: cleanError(e.message) }
              : x
          ),
        },
      }));
      return;
    }
    if (isStale(s0, e)) return;
    const failed = s0.agents.find((a) => a.id === e.agentId && a.attemptId === e.attemptId);
    if (
      failed?.viaGateway &&
      s0.settings.gatewayId === "wiro" &&
      isPermanentGatewayFailure(e.message)
    ) {
      const probes = {
        ...s0.settings.probes,
        [failed.model]: {
          ok: false,
          ms: 0,
          error: cleanError(e.message),
          at: Date.now(),
          vision: s0.settings.probes[failed.model]?.vision ?? null,
          visionNote: s0.settings.probes[failed.model]?.visionNote ?? null,
        },
      };
      get().patchSettings({ probes });
    }
    set((s) => {
      const agents = s.agents.map((a) =>
        a.id === e.agentId
          ? { ...a, status: "error" as const, error: cleanError(e.message), final: null }
          : a
      );
      const stillGoing =
        agents.some((a) => a.status === "streaming" || a.status === "queued") ||
        COUNCIL_ACTIVE.includes(s.council.phase);
      const next = { agents, running: stillGoing };
      publishOverlayState({ ...s, ...next });
      return next;
    });
    get().maybeAutoJudge();
    get().maybeStartCouncil();
  },

  /**
   * Fires once the last agent lands. The lexical verdict is a fast first read;
   * where it is least trustworthy, this quietly gets a second opinion instead of
   * waiting for the user to notice they should ask for one.
   */
  maybeAutoJudge: () => {
    const s = get();
    if (s.running) return;

    /**
     * A pane that has not started yet is not a pane that failed.
     *
     * The gateway paces requests, so with four seats the last one can begin
     * seconds after the first — and a run was being judged the moment the
     * *finished* panes settled, while a slow starter was still sitting in
     * "queued". The verdict then described three answers and called the fourth
     * an outlier for not existing yet.
     *
     * So: if anything is still waiting to begin, come back shortly rather than
     * deciding without it. The re-check is cheap and only fires while a pane is
     * genuinely pending.
     */
    const pending = s.agents.filter((a) => a.enabled && a.status === "queued");
    if (pending.length && lateStarterWaits < LATE_STARTER_TRIES) {
      if (!lateStarterCheck) {
        lateStarterWaits += 1;
        lateStarterCheck = setTimeout(() => {
          lateStarterCheck = null;
          get().maybeAutoJudge();
        }, LATE_STARTER_GRACE_MS);
      }
      return;
    }
    if (lateStarterCheck) {
      clearTimeout(lateStarterCheck);
      lateStarterCheck = null;
    }
    if (s.judge.status === "running" || s.judge.status === "done") return;

    // Decided as one answer rather than a ladder of early returns, because every
    // "no" is also the point at which the run has finished and should be written
    // to history. Returning early from any of them silently lost the run.
    const willJudge = (() => {
      const mode = s.settings.autoJudge;
      if (mode === "off") return false;
      if (s.agents.filter((a) => a.enabled && a.final).length < 2) return false;
      // Route, not key. This asked for a vendor key the gateway makes
      // unnecessary, so with TokenRouter carrying everything the judge could
      // never fire -- "Always" included -- and there was nothing on screen to
      // say why.
      if (!routeFor(s.settings.judgeProvider, s.settings, s.keys, s.gatewayKey)) return false;
      if (mode === "prose" && s.consensus().reliability === "high") return false;
      // The council re-solves the problem and then re-judges it as part of its
      // own bench; running the single judge first would spend a request to
      // produce a verdict the council is about to supersede.
      if (s.settings.councilEnabled) return false;
      return true;
    })();

    // When the judge runs, persistence waits for it so its reasoning is part of
    // the same record.
    // The read-out is what a person actually reads, so it runs whether or not
    // the judge does — it is a different question from "did they agree".
    void get().runReview();
    if (willJudge) void get().runJudge();
    else void get().persistRun();
  },

  /**
   * Saves the run to history.
   *
   * Called once the judge has settled rather than the moment the agents finish,
   * so the judge's reasoning is part of the same record instead of needing a
   * second write. Guarded by `runPersisted` because several paths reach here.
   */
  /** The runs this session has finished. */
  loadHistory: async () => {
    const sessionId = get().currentSessionId;
    if (!sessionId) {
      set({ history: [], historyError: null });
      return;
    }
    set({ historyLoading: true, historyError: null });
    try {
      set({ history: await db.listRuns(sessionId), historyLoading: false });
    } catch (err) {
      set({ historyLoading: false, historyError: cleanError(String(err)) });
    }
  },

  /**
   * Put a past run back on the panes.
   *
   * Each stored answer goes to the pane that produced it, matched by provider
   * and falling back to the model id — a roster can be edited between the run
   * and the reading of it, and an answer with nowhere to sit would otherwise
   * vanish silently. Panes with nothing stored are blanked rather than left
   * holding the live run's text, which would read as part of the history.
   */
  openRun: async (runId) => {
    const s = get();
    if (s.running) return;

    // Keep the live run aside the first time, so leaving history restores it.
    const live = (s.viewingRunId ? liveSnapshot : null) ?? { agents: s.agents, note: s.note };
    if (!s.viewingRunId) liveSnapshot = { agents: s.agents, note: s.note };

    set({ historyError: null });
    try {
      const detail = await db.getRun(runId);
      const byProvider = new Map(detail.responses.map((r) => [r.provider, r]));
      const byModel = new Map(detail.responses.map((r) => [r.model, r]));

      const agents = s.agents.map((slot) => {
        const stored = byProvider.get(slot.provider) ?? byModel.get(slot.model);
        if (!stored) {
          return { ...slot, status: "idle" as AgentStatus, text: "", error: null, final: null, attemptId: null };
        }
        return {
          ...slot,
          model: stored.model,
          status: (stored.status === "done" ? "done" : stored.status === "cancelled" ? "cancelled" : "error") as AgentStatus,
          text: stored.body,
          error: stored.error,
          inputTokens: stored.inputTokens,
          outputTokens: stored.outputTokens,
          elapsedMs: stored.elapsedMs,
          startedAt: null,
          final: parseFinal(stored.body),
          attemptId: stored.attemptId,
        };
      });

      set({
        agents,
        note: detail.run.asked,
        viewingRunId: runId,
        judge: detail.verdict?.judgeText
          ? {
              status: "done" as const,
              provider: (detail.verdict.judgeProvider || "") as ProviderId,
              text: detail.verdict.judgeText,
              error: null,
            }
          : { status: "idle" as const, provider: s.settings.judgeProvider, text: "", error: null },
      });
    } catch (err) {
      // Nothing was replaced, so there is nothing to put back.
      if (!s.viewingRunId) liveSnapshot = null;
      set({ agents: live.agents, note: live.note, historyError: cleanError(String(err)) });
    }
  },

  /** Back to the run that was on screen before history was opened. */
  exitHistory: () => {
    const kept = liveSnapshot;
    liveSnapshot = null;
    set({
      viewingRunId: null,
      historyError: null,
      ...(kept ? { agents: kept.agents, note: kept.note } : {}),
      judge: { status: "idle", provider: get().settings.judgeProvider, text: "", error: null },
    });
  },

  persistRun: async () => {
    const s = get();
    if (s.runPersisted || s.running) return;
    const sessionId = s.currentSessionId;
    if (!sessionId) return;

      const answered = s.agents.filter((a) => a.enabled && (a.final || a.error));
    if (!answered.length) return;

    // A council run persists when the council settles, not here. Its record
    // carries the panel's answers plus everything the council produced, so
    // writing the panel alone first would leave a run in history that reads as
    // though nobody reviewed it. Phase "idle" means the council never formed
    // (no gateway, too few solvers), which must not park persistence forever.
    if (s.settings.councilEnabled && COUNCIL_ACTIVE.includes(s.council.phase)) return;

    // Claim it before the await, so two callers landing together cannot both
    // pass the guard and write the run twice.
    set({ runPersisted: true });

    const result = s.consensus();
    try {
      await db.saveRun({
        sessionId,
        mode: s.settings.mode,
        asked: s.note,
        // What the agents were actually given. Without this, a run in history is
        // an answer with no record of what question produced it.
        contextMode: s.settings.contextMode,
        extractedContext: s.extraction.context,
        extractionAgreed: s.extraction.agreement ? s.extraction.agreement.agree : null,
        responses: answered.map((a) => ({
          provider: a.provider,
          model: a.model,
          attemptId: a.attemptId ?? "",
          status: a.status,
          body: a.text,
          finalKind: a.final?.kind ?? null,
          finalLanguage: a.final?.language || null,
          finalAnswer: a.final?.answer || null,
          finalCode: a.final?.code || null,
          finalClaims: a.final?.claims ?? [],
          complexity: a.final?.complexity || null,
          confidence: a.final?.confidence ?? null,
          wellFormed: a.final?.wellFormed ?? false,
          inputTokens: a.inputTokens,
          outputTokens: a.outputTokens,
          elapsedMs: a.elapsedMs,
          error: a.error,
        })),
        verdict: {
          verdict: result.verdict,
          headline: result.headline,
          detail: result.detail,
          reliability: result.reliability,
          camps: result.groups,
          outliers: result.outliers,
          representative: result.representative,
          judgeProvider:
            s.judge.status === "done"
              ? s.judge.provider
              : s.council.phase === "done"
                ? "council"
                : null,
          judgeText:
            s.judge.status === "done"
              ? s.judge.text
              : s.council.phase === "done"
                ? councilMarkdown(councilReportFrom(get().council))
                : null,
        },
      });
      await get().loadSessions();
    } catch (err) {
      // History failing must not look like the run failing. The answers are on
      // screen either way.
      set({ runPersisted: false, sessionsError: cleanError(String(err)) });
    }
  },

  consensus: () => {
    const { agents, settings } = get();
    const inputs = agents
      .filter((a) => a.enabled && a.final)
      .map((a) => ({ id: a.id, name: agentSpec(a.provider).label, final: a.final! }));
    return computeConsensus(inputs, settings.threshold);
  },

  /**
   * The bridge from panel to council.
   *
   * Fires once the last pane settles, in the same place the auto-judge does.
   * The two never overlap: a council run supersedes adjudication entirely, so
   * when the council is enabled the single judge stays out of its way rather
   * than spending a request grading a field the bench is about to re-grade.
   */
  // ----------------------------------------------------------- knowledge
  //
  // The library is a folder of markdown files. Reading and writing are local
  // and immediate; publishing to the database the cloud worker reads is a
  // separate step, so a half-written thought never reaches a running job.

  loadKnowledge: async () => {
    if (!bridge.inTauri()) return;
    set((st) => ({ knowledge: { ...st.knowledge, loading: true, error: null } }));
    try {
      const [files, folder] = await Promise.all([bridge.knowledgeList(), bridge.knowledgeFolder()]);
      const entries: KnowledgeEntry[] = files.map((f) => {
        const parsed = markdownToRecord(f.markdown);
        return {
          ...f,
          // The front matter wins over the folder when they disagree: someone
          // who typed `collection: AWS` said what they meant, and the next save
          // moves the file to match.
          category: parsed.category || f.category,
          record: parsed.record,
          problems: parsed.problems,
          source: "file" as const,
        };
      });

      // Everything this build already knows, shown beside what you have
      // written. Before this the tab opened on an empty list and a button, which
      // reads as "there is no library" next to a council that was demonstrably
      // using one.
      const onDisk = new Set(entries.map((e) => e.id));
      for (const record of allKnowledgeRecords()) {
        if (onDisk.has(record.id)) continue;
        entries.push({
          id: record.id,
          category: "Built-in",
          markdown: recordToMarkdown(record),
          path: "",
          updatedAt: 0,
          record,
          problems: [],
          source: "built-in",
        });
      }
      set((st) => {
        // A draft in progress outlives a reload: re-reading the folder must
        // never be the thing that loses what someone was typing.
        const keepDraft = st.knowledge.dirty;
        const selected = st.knowledge.selectedId || entries[0]?.id || "";
        const current = entries.find((e) => e.id === selected);
        return {
          knowledge: {
            ...st.knowledge,
            entries,
            folder,
            loading: false,
            error: null,
            selectedId: selected,
            draft: keepDraft ? st.knowledge.draft : current?.markdown ?? st.knowledge.draft,
          },
        };
      });
    } catch (err) {
      set((st) => ({ knowledge: { ...st.knowledge, loading: false, error: cleanError(String(err)) } }));
    }
  },

  importBundledKnowledge: async () => {
    if (!bridge.inTauri()) return;
    set((st) => ({ knowledge: { ...st.knowledge, saving: true, error: null } }));
    try {
      // The pack compiled into this build, written out as files you can edit.
      // An empty folder is a worse starting point than 37 real records: it
      // gives nothing to copy the shape from.
      for (const record of allKnowledgeRecords()) {
        await bridge.knowledgeSave(record.id, recordToMarkdown(record, "Built-in"), "Built-in", null, "");
      }
      set((st) => ({ knowledge: { ...st.knowledge, saving: false } }));
      await get().loadKnowledge();
    } catch (err) {
      set((st) => ({ knowledge: { ...st.knowledge, saving: false, error: cleanError(String(err)) } }));
    }
  },

  syncKnowledge: async () => {
    if (!bridge.inTauri()) return;
    const st = get();
    // Only what is ready. A record with no guidance is a draft, and the whole
    // point of a button rather than a background sync is that drafts stay on
    // this machine until they are finished.
    const ready = st.knowledge.entries
      .map((e) => e.record)
      .filter((r) => r.id && r.title && r.guidance.length > 0);
    const held = st.knowledge.entries.length - ready.length;
    if (!ready.length) {
      set((s2) => ({
        knowledge: {
          ...s2.knowledge,
          error: "Nothing here is ready to publish — every record needs a title and at least one guidance line.",
        },
      }));
      return;
    }
    set((s2) => ({ knowledge: { ...s2.knowledge, syncing: true, error: null, syncNote: "" } }));
    try {
      const result = await bridge.knowledgePublish(ready);
      set((s2) => ({
        knowledge: {
          ...s2.knowledge,
          syncing: false,
          syncedAt: Date.now(),
          syncNote:
            `Published ${result.published} record(s) to the cloud worker` +
            (held ? `, holding ${held} unfinished here` : "") +
            // Not a failure, and not silent either: the shelf is shared, and
            // replacing text another machine published is worth seeing.
            (result.replaced?.length
              ? `. Replaced ${result.replaced.length} record(s) another machine had published: ${result.replaced
                  .map((r) => r.title)
                  .slice(0, 3)
                  .join(", ")}.`
              : "."),
        },
      }));
    } catch (err) {
      set((s2) => ({
        knowledge: { ...s2.knowledge, syncing: false, error: cleanError(String(err)), syncNote: "" },
      }));
    }
  },

  selectKnowledge: (id) => {
    const st = get();
    const entry = st.knowledge.entries.find((e) => e.id === id);
    set({
      knowledge: {
        ...st.knowledge,
        selectedId: id,
        draft: entry?.markdown ?? blankDocument(),
        dirty: false,
        error: null,
        savedAt: null,
      },
    });
  },

  newKnowledge: () => {
    set((st) => ({
      knowledge: { ...st.knowledge, selectedId: "", draft: blankDocument(), dirty: false, error: null, savedAt: null },
    }));
  },

  editKnowledge: (markdown) => {
    set((st) => ({ knowledge: { ...st.knowledge, draft: markdown, dirty: true, savedAt: null } }));
  },

  saveKnowledge: async () => {
    const st = get();
    const { draft, selectedId } = st.knowledge;
    const parsed = markdownToRecord(draft);
    // The id is the file name, so it has to exist before anything is written.
    // Everything else the parser complains about is shown beside the editor and
    // saved anyway: a record you are still writing is still worth keeping.
    const id = parsed.record.id || slugify(parsed.record.title);
    if (!id) {
      set((s2) => ({
        knowledge: { ...s2.knowledge, error: "Give the record a title or an id before saving." },
      }));
      return;
    }
    set((s2) => ({ knowledge: { ...s2.knowledge, saving: true, error: null } }));
    try {
      const previous = st.knowledge.entries.find((e) => e.id === selectedId);
      const saved = await bridge.knowledgeSave(
        id,
        draft,
        parsed.category,
        selectedId || null,
        // A built-in record has no file to move, so nothing is removed when the
        // first edit of one lands on disk.
        previous?.source === "file" ? previous.category : ""
      );
      const entry: KnowledgeEntry = {
        ...saved,
        category: parsed.category || saved.category,
        record: parsed.record,
        problems: parsed.problems,
        source: "file",
      };
      set((s2) => {
        const rest = s2.knowledge.entries.filter((e) => e.id !== entry.id && e.id !== selectedId);
        return {
          knowledge: {
            ...s2.knowledge,
            entries: [entry, ...rest].sort((a, b) => b.updatedAt - a.updatedAt),
            selectedId: entry.id,
            saving: false,
            dirty: false,
            savedAt: Date.now(),
            error: null,
          },
        };
      });
    } catch (err) {
      set((s2) => ({ knowledge: { ...s2.knowledge, saving: false, error: cleanError(String(err)) } }));
    }
  },

  deleteKnowledge: async (id) => {
    const entry = get().knowledge.entries.find((e) => e.id === id);
    if (entry?.source === "built-in") {
      // There is no file to remove, and pretending otherwise would suggest the
      // built-in library can be edited away. It cannot; it ships with the app.
      set((st) => ({
        knowledge: { ...st.knowledge, error: "That record is built into this build, so there is no file to delete." },
      }));
      return;
    }
    try {
      await bridge.knowledgeDelete(id, entry?.category ?? "");
    } catch (err) {
      set((st) => ({ knowledge: { ...st.knowledge, error: cleanError(String(err)) } }));
      return;
    }
    set((st) => {
      const entries = st.knowledge.entries.filter((e) => e.id !== id);
      const next = entries[0];
      return {
        knowledge: {
          ...st.knowledge,
          entries,
          selectedId: next?.id ?? "",
          draft: next?.markdown ?? blankDocument(),
          dirty: false,
          error: null,
        },
      };
    });
  },

  maybeStartCouncil: () => {
    const s = get();
    if (s.running) return;
    if (!s.settings.councilEnabled) return;
    if (!s.settings.useGateway || !s.gatewayKey) return;
    const answered = s.agents.filter((a) => a.enabled && a.final);
    if (answered.length < COUNCIL_SIZE.solversMin && !s.settings.councilModels.length) return;
    if (s.council.phase !== "idle") return;
    void runCouncil(get, set);
  },

  sendCouncilMessage: async (message, models) => {
    const text = message.trim();
    if (!text) return;
    const s = get();
    const chosen = Array.from(new Set(models.map((m) => m.trim()).filter(Boolean)));
    if (!chosen.length) return;
    if (!s.settings.useGateway || !s.gatewayKey) {
      set({ settingsOpen: true });
      get().pushToast("warn", "Council chat needs TokenRouter", "Add or enable the gateway key to continue a council conversation.", { sticky: true });
      return;
    }
    if (!s.council.synthesis && s.council.phase !== "done") {
      get().pushToast("warn", "No finished council yet", "Run the council first, then ask follow-up questions from its final record.");
      return;
    }

    const userMsg: CouncilChatMessage = {
      id: `chat-user-${Date.now().toString(36)}`,
      role: "user",
      model: null,
      text,
      error: null,
      createdAt: Date.now(),
    };
    set((st) => ({
      council: {
        ...st.council,
        chat: [...st.council.chat, userMsg],
        chatSending: true,
      },
    }));

    const report = councilMarkdown(councilReportFrom(s.council));
    const history = s.council.chat
      .slice(-12)
      .map((m) => `${m.role === "user" ? "User" : m.model || "Model"}: ${m.text || m.error || ""}`)
      .join("\n\n");

    const replies = await Promise.all(
      chosen.map(async (model) => {
        try {
          const reply = await bridge.runOnce({
            runId: `council-chat-${Date.now().toString(36)}`,
            agentId: `council-chat:${model}`,
            attemptId: newAttemptId(),
            provider: s.settings.gatewayId,
            model,
            systemPrompt: councilFollowupSystemPrompt(),
            userText: councilFollowupUserPrompt({
              question: s.note,
              report,
              history,
              message: text,
            }),
            images: [],
            maxTokens: s.settings.maxTokens,
            temperature: 0,
            baseUrl: s.settings.gatewayBaseUrl || gatewayPreset(s.settings.gatewayId).defaultBaseUrl,
            endpoint: endpointForModel(s.settings, model),
          });
          return {
            id: `chat-reply-${model}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            role: "assistant" as const,
            model,
            text: reply,
            error: null,
            createdAt: Date.now(),
          };
        } catch (err) {
          return {
            id: `chat-reply-${model}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            role: "assistant" as const,
            model,
            text: "",
            error: cleanError(String(err)),
            createdAt: Date.now(),
          };
        }
      })
    );

    set((st) => ({
      council: {
        ...st.council,
        chat: [...st.council.chat, ...replies],
        chatSending: false,
      },
    }));
  },

  setReviewLanguage: (language) => set((s) => ({ review: { ...s.review, language } })),

  /**
   * Reviews whichever answer the panel settled on.
   *
   * The representative of the largest agreeing group, because that is the
   * answer a reader is actually looking at; falling back to the first agent
   * that produced code at all. One model call — the ports come back in the same
   * reply, so asking for three languages costs nothing beyond the tokens.
   */
  runReview: async () => {
    const s = get();
    if (s.review.status === "running") return;

    const consensus = s.consensus();
    const answered = s.agents.filter((a) => a.enabled && a.final?.code?.trim());
    const pick =
      answered.find((a) => a.id === consensus.representative) ??
      answered.find((a) => a.final?.wellFormed) ??
      answered[0];

    if (!pick?.final) {
      set((st) => ({
        review: { ...st.review, status: "error", data: null, error: "No agent produced code to review." },
      }));
      publishOverlayState(get());
      return;
    }

    const route = routeFor(s.settings.judgeProvider, s.settings, s.keys, s.gatewayKey);
    if (!route) {
      set((st) => ({
        review: { ...st.review, status: "error", data: null, error: "No route for the reviewer model." },
      }));
      publishOverlayState(get());
      return;
    }

    set((st) => ({ review: { ...st.review, status: "running", error: null } }));
    publishOverlayState(get());
    try {
      const text = await bridge.runOnce({
        runId: `review-${Date.now().toString(36)}`,
        agentId: "judge",
        attemptId: newAttemptId(),
        provider: route.provider,
        model: route.model,
        systemPrompt: reviewSystemPromptFor(),
        userText: reviewUserPromptFor({
          question: `${s.note}\n\n${s.extraction.context}`.trim(),
          language: pick.final.language,
          code: pick.final.code,
          answer: pick.final.answer,
        }),
        images: [],
        maxTokens: s.settings.maxTokens,
        temperature: 0,
        baseUrl: route.baseUrl,
        endpoint: endpointForModel(s.settings, route.model),
      });

      const data = parseReview(text);
      set((st) => ({
        review: data
          ? { ...st.review, status: "done", data, error: null }
          : { ...st.review, status: "error", data: null, error: "The reviewer did not answer in the expected form." },
      }));
      publishOverlayState(get());
    } catch (err) {
      set((st) => ({ review: { ...st.review, status: "error", data: null, error: cleanError(String(err)) } }));
      publishOverlayState(get());
    }
  },

  runJudge: async () => {
    const { agents, settings, note, keys, gatewayKey } = get();
    const provider = settings.judgeProvider;
    const route = routeFor(provider, settings, keys, gatewayKey);
    if (!route) {
      set({ settingsOpen: true });
      return;
    }
    const entries = agents
      .filter((a) => a.enabled && a.final)
      .map((a) => ({ name: agentSpec(a.provider).label, final: a.final!.raw }));

    if (entries.length < 2) {
      set({
        judge: {
          status: "error",
          provider,
          text: "",
          error: "Need at least two finished answers before there is anything to judge.",
        },
      });
      return;
    }

    set({ judge: { status: "running", provider, text: "", error: null } });
    try {
      const text = await bridge.runOnce({
        runId: `judge-${Date.now().toString(36)}`,
        agentId: "judge",
        attemptId: newAttemptId(),
        provider: route.provider,
        model: route.model,
        systemPrompt:
          "You are an exacting technical reviewer. You verify claims yourself instead of deferring to the majority, and you say plainly when you cannot determine the answer.",
        userText: judgePromptWithKnowledge(entries, note, knowledgePackFor(note, 5)),
        images: [],
        maxTokens: settings.maxTokens,
        temperature: 0,
        baseUrl: route.baseUrl,
        endpoint: endpointForModel(settings, route.model),
      });
      set({ judge: { status: "done", provider, text, error: null } });
      void get().persistRun();
    } catch (err) {
      set({ judge: { status: "error", provider, text: "", error: cleanError(String(err)) } });
      // A judge that failed is still a run worth keeping.
      void get().persistRun();
    }
  },
}));

function cleanError(msg: string): string {
  return msg.replace(/^Error:\s*/, "").trim();
}

// ------------------------------------------------------------------ the council
//
// The orchestrator. Everything from here to `isStale` is one machine: it takes
// the settled panel, adds gateway-only solvers to fill the bench out to ten,
// and then runs spec → execute → review → revise → re-execute → judge →
// synthesize, pausing between dispatches so the shared rate governor is not
// asked for eleven requests inside one second.
//
// Cancellation is a phase flag, not an exception: every `wait` and every
// `Promise.all` boundary checks `councilAlive`, and a cancelled run writes its
// partial record — a bench that produced three of five judge reports is still
// evidence worth keeping.

type GetStore = () => State;
/** Matches the signature `create<State>` hands the initialiser. */
type SetStore = (partial: Partial<State> | ((s: State) => Partial<State>)) => void;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True while the council the state points at is still the live one. */
function councilAlive(c: CouncilState, runId: string): boolean {
  return c.runId === runId && !["cancelled", "error", "done"].includes(c.phase);
}

/**
 * The model id a gateway request should ask for, namespaced or not.
 *
 * The free-text fields in Settings accept both spellings and the router
 * accepts both spellings, so this is only trimming: the gateway namespaces by
 * vendor on its catalogue pages but serves the bare id identically.
 */
function gatewayRoute(model: string, s: Settings): { provider: TransportId; model: string; baseUrl: string } | null {
  const id = model.trim();
  if (unavailableWiroGatewayModel(id, s)) return null;
  return {
    provider: s.gatewayId,
    model: id,
    baseUrl: s.gatewayBaseUrl || gatewayPreset(s.gatewayId).defaultBaseUrl,
  };
}

/** One streamed call, with a slot the UI can watch. Resolves on done/error. */
function runCouncilSlot(
  get: GetStore,
  set: SetStore,
  slot: Omit<CouncilSlot, "status" | "text" | "error" | "attemptId" | "elapsedMs">,
  req: Omit<bridge.RunRequest, "runId" | "agentId" | "attemptId" | "provider" | "baseUrl"> & { endpoint?: "chat" | "responses" },
  s: Settings
): Promise<CouncilSlot> {
  const attemptId = newAttemptId();
  const runId = get().council.runId ?? `council-${Date.now().toString(36)}`;
  const route = gatewayRoute(slot.model, s);
  if (!route) {
    const blocked: CouncilSlot = {
      ...slot,
      status: "error",
      text: "",
      error: `${slot.model} is unavailable through Wiro, so it was not called.`,
      attemptId,
      elapsedMs: null,
    };
    set((st) => ({
      council: { ...st.council, slots: st.council.slots.map((x) => (x.id === blocked.id ? blocked : x)) },
    }));
    return Promise.resolve(blocked);
  }
  const live: CouncilSlot = { ...slot, status: "queued", text: "", error: null, attemptId, elapsedMs: null };

  set((st) => ({
    council: {
      ...st.council,
      slots: st.council.slots.map((x) => (x.id === live.id ? live : x)),
    },
  }));

  return new Promise<CouncilSlot>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // A reasoning seat can legitimately think for minutes and the gateway
    // holds the stream open the whole time. That is not a hang and the prompt
    // is told so. What a hang looks like is no first token by dawn; twelve
    // minutes is long enough for one slow thinking round and short enough to
    // not eat the council indefinitely.
    const giveUpAt = Date.now() + 12 * 60 * 1000;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      const done = get().council.slots.find((x) => x.id === live.id);
      resolve(done ?? { ...live, status: "error", error: "slot vanished" });
    };
    timer = setInterval(() => {
      const cur = get().council.slots.find((x) => x.id === live.id);
      if (!cur || cur.status === "done" || cur.status === "error" || cur.status === "cancelled") finish();
      else if (Date.now() > giveUpAt && (cur.status === "queued" || cur.status === "streaming")) {
        set((st) => ({
          council: {
            ...st.council,
            slots: st.council.slots.map((x) =>
              x.id === live.id
                ? { ...x, status: "error" as const, error: "Gave no first token inside 12 minutes — the governor will keep it out of the way next time." }
                : x
            ),
          },
        }));
        finish();
      }
    }, 250);
    // Not the pane id: that is `agents`' keyspace, and a council event that
    // matched one would splice its tokens into a solver's column. The council
    // claims its own keyspace instead, and the guards in finishAgent/failAgent
    // route on it.
    void bridge
      .runAgent({
        ...req,
        runId,
        agentId: live.id,
        attemptId,
        provider: route.provider,
        model: route.model,
        baseUrl: route.baseUrl,
      })
      .catch((err) => {
        if (settled) return;
        set((st) => ({
          council: {
            ...st.council,
            slots: st.council.slots.map((x) =>
              x.id === live.id
                ? { ...x, status: "error" as const, error: cleanError(String(err)) }
                : x
            ),
          },
        }));
        finish();
      });
  });
}

/**
 * Executes every member of the field that has code, against the suites the
 * spec pass produced. Deliberately sequential: the runner spawns real
 * processes, and ten of them competing for the same CPU would measure
 * scheduling, not the code.
 */
async function executeField(
  get: GetStore,
  set: SetStore,
  runId: string,
  field: Candidate[],
  suites: TestSuite[],
  which: "runs" | "revisedRuns"
): Promise<void> {
  for (const c of field) {
    if (!councilAlive(get().council, runId)) return;
    const f = which === "revisedRuns" ? (c.revised ?? c.final) : c.final;
    const lang = f?.kind === "code" ? candidateLanguage(f) : "";
    const suite = lang ? suites.find((s) => s.language === lang) : undefined;
    const code = which === "revisedRuns" && c.revised ? c.revised.code : (f?.code ?? "");
    const setRun = (run: CandidateRun) =>
      set((st) => ({
        council: { ...st.council, [which]: { ...st.council[which], [c.letter]: run } },
      }));

    if (!f || f.kind !== "code" || !code.trim()) {
      setRun({ letter: c.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: f?.kind === "research" ? "research answer" : "no code", runtime: "" });
      continue;
    }
    if (!suite) {
      setRun({ letter: c.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: `no suite for ${lang || "unknown language"}`, runtime: "" });
      continue;
    }
    const program = spliceSuite(suite, code);
    if (!program) {
      setRun({ letter: c.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: "harness has no splice marker", runtime: "" });
      continue;
    }
    try {
      const r = await bridge.runCode({ language: suite.language, code: program, timeoutMs: 20000 });
      const { passed, failed } = countCases(r.stdout);
      setRun({
        letter: c.letter,
        ran: true,
        ok: r.ok,
        passed,
        failed,
        durationMs: r.durationMs,
        note: r.timedOut ? "timed out" : r.exitCode !== 0 ? `exit ${r.exitCode}` : "",
        runtime: r.runtime,
      });
    } catch (err) {
      setRun({ letter: c.letter, ran: false, ok: false, passed: 0, failed: 0, durationMs: 0, note: cleanError(String(err)), runtime: "" });
    }
  }
}

/**
 * Is the harness worth believing?
 *
 * One deliberately broken copy of a candidate that passed, through the same
 * suite. A harness that passes it has not verified anything it accepted — and
 * nothing else in the pipeline can notice that, because the gate can only
 * reject what its evidence rejects, and evidence that accepts everything
 * rejects nothing.
 *
 * The result never moves a candidate. It is a sentence the judges read before
 * they read the scores, which is the same treatment `harnessIsSuspect` gets and
 * for the same reason: a doubt about the measurement is not a verdict about the
 * thing measured.
 */
async function runMutationOracle(
  get: GetStore,
  set: SetStore,
  field: Candidate[],
  suites: TestSuite[]
): Promise<void> {
  const runs = get().council.runs;
  const passing = field.find((c) => gateFor(runs[c.letter]) === "pass" && c.final?.code?.trim());
  if (!passing?.final) return;
  const suite = suites.find((x) => x.language === candidateLanguage(passing.final!));
  if (!suite) return;
  const mutation = mutateCode(passing.final.code ?? "");
  if (!mutation.applied) return;
  const program = spliceSuite(suite, mutation.code);
  if (!program) return;

  try {
    const r = await bridge.runCode({ language: suite.language, code: program, timeoutMs: 20000 });
    const { passed, failed } = countCases(r.stdout);
    const survived = r.ok && failed === 0 && passed > 0;
    const signal: OracleSignal = {
      kind: "mutation",
      letter: passing.letter,
      ran: true,
      survived,
      description: mutation.description,
      note: survived ? `${passed} case(s) passed on a broken program` : `${failed} case(s) caught the break`,
    };
    set((st) => ({ council: { ...st.council, oracles: [...st.council.oracles, signal] } }));
  } catch {
    // A mutation that could not be run is not evidence of anything. The council
    // proceeds exactly as it did before this check existed.
  }
}

/** Assembles the persisted/rendered report from live council state. */
function councilReportFrom(c: CouncilState): CouncilReport {
  const report: CouncilReport = {
    candidates: c.candidates,
    suites: c.testSuites,
    runs: c.runs,
    revisedRuns: c.revisedRuns,
    reviews: c.reviews,
    judges: c.judges,
    synthesis: c.synthesis,
    winner: c.winner,
    dossier: c.dossier,
    contract: c.contract,
    contractAgreement: c.contractAgreement,
    oracles: c.oracles,
  };
  return { ...report, presentation: buildPresentation(report) };
}

async function runCouncil(get: GetStore, set: SetStore): Promise<void> {
  // Read the knowledge folder once per session, here rather than at launch: a
  // library nobody has opened should not cost a disk read on every start, and a
  // council that is about to search it is exactly when it is worth reading.
  if (!get().knowledge.folder && bridge.inTauri()) await get().loadKnowledge();
  const s0 = get();
  const settings = s0.settings;
  const runId = `council-${Date.now().toString(36)}`;
  set(() => ({ council: { ...IDLE_COUNCIL, phase: "solving" as const, runId } }));

  // ---------------------------------------------------------- round 1: solve
  //
  // The visible panel is always part of the field — its answers are on screen
  // and already paid for. The declared roster fills out the rest, and one leg
  // it asks for is the reverse: a declared model that is also a *pane* is the
  // same solver, so the panel's own answer stands in for its seat rather than
  // paying for a second opinion of itself.
  const paneAnswers = s0.agents.filter((a) => a.enabled && a.final);
  const paneModels = new Set(paneAnswers.map((a) => a.model));
  const extras = settings.councilIncludePanel
    ? settings.councilModels.filter((m) => !paneModels.has(m.id))
    : settings.councilModels;

  // ------------------------------------------------------ the problem contract
  //
  // Read before anybody answers, by two models, and injected into every prompt
  // from here down. Without it each stage inherits whichever restatement of the
  // question it happened to be given: the harness tests the spec writer's
  // reading of the problem, the reviewers grade against their own, and a
  // disagreement about what was *asked* arrives disguised as a disagreement
  // about who is right.
  const reading = s0.extraction.agreement?.merged;
  const readers = s0.extraction.readings.map(r=>r.extraction);
  const route = readers.length ? reconcileProblemReadings(readers)
    : reading ? routeProblem(reading) : routeUnparsedProblem(s0.note, s0.images.length > 0);
  const contractSeats = selectContractReaders(settings.councilModels ?? [], m=>m.id,
    s0.images.length>0 && route.path!=="standard", VISION_PREFERENCE);
  let contract: ProblemContract | null = null;
  let contractAgreement: ContractAgreement | null = null;
  if (contractSeats.length && settings.councilProblemContract !== false) {
    set((st) => ({ council: { ...st.council, phase: "contracting" as const } }));
    const contractSlots: CouncilSlot[] = contractSeats.map((entry, i) => ({
      id: `council-contract:${i}`,
      kind: "contract",
      model: entry.id,
      status: "idle",
      text: "",
      error: null,
      attemptId: null,
      elapsedMs: null,
    }));
    set((st) => ({ council: { ...st.council, slots: contractSlots } }));
    await Promise.all(
      contractSlots.map((slot, i) =>
        wait(i * COUNCIL_STEP_MS).then(() => {
          if (!councilAlive(get().council, runId)) return null;
          return runCouncilSlot(
            get,
            set,
            slot,
            {
              model: slot.model,
              endpoint: endpointForModel(settings, slot.model),
              systemPrompt: contractSystemPrompt(),
              userText: contractUserPrompt({ question: s0.note, reading: s0.extraction.context }),
              images: s0.images.map((i) => ({ mime: i.mime, data: i.base64 })),
              maxTokens: Math.min(settings.maxTokens, 2048),
              temperature: 0,
            },
            settings
          );
        })
      )
    );
    if (!councilAlive(get().council, runId)) {
      set({ running: false });
      void get().persistRun();
      return;
    }
    const readings = get()
      .council.slots.filter((x) => x.kind === "contract" && x.status === "done")
      .map((x) => parseProblemContract(x.text));
    const merged = mergeProblemContracts(readings);
    contract = merged.contract;
    contractAgreement = merged.agreement;
    set((st) => ({ council: { ...st.council, contract, contractAgreement } }));
  }
  const contractText = contractBlock(contract);
  // One string, handed to every later stage as "the problem". A contract that
  // only some prompts saw would be worse than none: the stages that read it and
  // the stages that did not would be answering different questions.
  const problem = contractText ? `${s0.note}\n\n---\n\n${contractText}` : s0.note;

  set((st) => ({ council: { ...st.council, phase: "solving" as const } }));
  const seats = Math.max(0, COUNCIL_SIZE.solversMax - paneAnswers.length);
  const capabilityEvidence: ModelCapability[] = (settings.councilModels ?? []).map(m => {
    const probe = settings.probes?.[m.id];
    return {
      id: m.id,
      families: m.expertise,
      // An actual image probe overrides a user's manually configured guess.
      vision: typeof probe?.vision === "boolean" ? probe.vision : m.vision,
      verifiedVisual: probe?.vision === true,
      availability: probe && !probe.ok ? "unknown" : "available",
      verifiedAccuracy: m.verifiedAccuracy,
      evaluatedSamples: m.evaluatedSamples,
      latencyMs: probe?.ok && Number.isFinite(probe.ms) ? probe.ms : m.latencyMs,
      costPerMillion: m.costPerMillion,
    };
  });
  // Preserve source-image evidence unless independent extraction is confident.
  // A contract alone is not proof that the pixels were understood.
  const safeTextOnly = s0.images.length > 0
    && Boolean(reading)
    && Number.isFinite(reading.confidence)
    && reading.confidence >= 0.85
    && route.path === "standard"
    && !(contractAgreement?.disagreements?.length);
  const selection = selectAdaptiveModels(extras, m => m.id, route, capabilityEvidence, seats,
    { excludedIds: [...paneModels], passesImages: s0.images.length > 0 && !safeTextOnly });
  const selectedSolvers = selection.selected;
  // If image-capable models are unavailable, do not turn an unread screenshot
  // into a guessed text prompt just to fill council seats.
  if (s0.images.length > 0 && !safeTextOnly && selectedSolvers.length === 0 && paneAnswers.length < 2) {
    set(st => ({ council: { ...st.council, phase: "error",
      error: "No verified vision-capable council solvers are available for this screenshot. Verify model vision or provide a independently checked transcription." }, running: false }));
    void get().persistRun();
    return;
  }
  const solveSlots: CouncilSlot[] = selectedSolvers.map((entry, i) => ({
    id: `council-solve:${i}`,
    kind: "solve",
    model: entry.id,
    status: "idle",
    text: "",
    error: null,
    attemptId: null,
    elapsedMs: null,
  }));
  set((st) => ({ council: { ...st.council, slots: solveSlots } }));

  const extractionCtx = s0.extraction.context;
  // The contract is part of the query, not just part of the prompt. It is the
  // one description of the problem that exists before anybody has attempted it,
  // so retrieving against it finds the technique the problem needs rather than
  // the technique the first answer happened to use.
  // The library this run searches: the pack compiled into the build, with the
  // records in your knowledge folder laid over it by id. Something you wrote
  // this morning is in front of the solvers this afternoon, with no deploy and
  // no sync — the cloud worker is the leg that waits for a publish.
  const localRecords = get().knowledge.entries.map((e) => e.record);
  const library = new Map(allKnowledgeRecords().map((r) => [r.id, r]));
  for (const record of localRecords) if (record.id) library.set(record.id, record);
  const knowledge = knowledgePackFor(
    [s0.note, extractionCtx, contractQuery(contract)].filter((x) => x && x.trim()).join("\n\n"),
    5,
    [...library.values()]
  );
  const sys = systemPrompt(
    settings.mode,
    resolveAnswerLanguage(settings.outputLanguage, get().extraction.agreement?.merged.language ?? "")
  );
  const allImages = s0.images.map((i) => ({ mime: i.mime, data: i.base64 }));
  await Promise.all(
    solveSlots.map((slot, i) =>
      wait(i * COUNCIL_STEP_MS).then(() => {
        if (!councilAlive(get().council, runId)) return null;
        const entry = selectedSolvers[i];
        return runCouncilSlot(
          get,
          set,
          slot,
          {
            model: entry.id,
            endpoint: endpointForModel(settings, entry.id),
            systemPrompt: sys,
            userText: userPrompt(
              problem,
              allImages.length > 0,
              extractionCtx,
              s0.images,
              knowledge,
              solutionPolicy(
                settings.solutionLanguages?.length ? settings.solutionLanguages : undefined,
                settings.memoryTargetKb || 20 * 1024
              )
            ),
            images: safeTextOnly ? [] : allImages,
            maxTokens: settings.maxTokens,
            temperature: 0,
          },
          settings
        );
      })
    )
  );
  if (!councilAlive(get().council, runId)) {
    set({ running: false });
    void get().persistRun();
    return;
  }

  // Build the field: panel answers first (in panel order), then extras in
  // roster order. Letters are assigned here and never change afterwards —
  // every review, run and revision refers to the same letter all the way down.
  const field: Candidate[] = [];
  for (const a of paneAnswers) {
    field.push({ letter: letterFor(field.length), model: a.model, final: a.final, text: a.text, error: a.error });
  }
  for (const slot of get().council.slots) {
    if (slot.kind !== "solve") continue;
    const doneSlot = get().council.slots.find((x) => x.id === slot.id);
    const text = doneSlot?.text ?? "";
    field.push({
      letter: letterFor(field.length),
      model: slot.model,
      final: text ? parseFinal(text) : null,
      text,
      error: doneSlot?.error ?? null,
    });
  }
  set((st) => ({
    council: { ...st.council, candidates: field },
    // The council is now the thing that is running: the CANCEL button, the
    // input bar and the run state should all read it, not think the app went
    // quiet when the last pane landed.
    running: true,
  }));

  if (field.filter((c) => c.final).length < 2) {
    set((st) => ({
      council: { ...st.council, phase: "error", error: "Fewer than two solvers produced an answer — nothing for a council to compare." },
      running: false,
    }));
    void get().persistRun();
    return;
  }

  // ------------------------------------------------------- round 1.5: spec
  //
  // One model writes the harness. Any answer that is not code skips straight
  // past this: there is nothing to execute, and asking a model to invent tests
  // for prose produces noise the gate then has to ignore anyway.
  const codeCandidates = field.filter((c) => c.final?.kind === "code" && c.final.code.trim());
  let suites: TestSuite[] = [];
  if (codeCandidates.length >= 2) {
    set((st) => ({ council: { ...st.council, phase: "speccing" } }));
    const specModel = settings.synthesisModel || settings.councilJudges[0]?.model || field[0].model;
    set((st) => ({ council: { ...st.council, specBy: specModel } }));
    const languages = Array.from(new Set(codeCandidates.map((c) => candidateLanguage(c.final!)).filter(Boolean)));
    try {
      const specText = await bridge.runOnce({
        runId,
        agentId: "council-spec",
        attemptId: newAttemptId(),
        provider: settings.gatewayId,
        model: specModel,
        systemPrompt: testSpecSystemPrompt(),
        userText: testSpecUserPrompt({ question: problem, docket: candidateDocket(field), languages, knowledge }),
        images: [],
        maxTokens: settings.maxTokens,
        temperature: 0,
        baseUrl: settings.gatewayBaseUrl || gatewayPreset(settings.gatewayId).defaultBaseUrl,
        endpoint: endpointForModel(settings, specModel),
      });
      suites = parseTestSuites(specText);
    } catch (err) {
      // A spec pass that fails costs verification, not the council: reviews and
      // judges still run, and every prompt they see says plainly that no
      // measured results exist.
      console.warn("Council spec pass failed:", cleanError(String(err)));
    }
    set((st) => ({ council: { ...st.council, testSuites: suites } }));
    publishOverlayState(get());
  }

  // -------------------------------------------------------- round 2c: verify
  if (suites.length) {
    set((st) => ({ council: { ...st.council, phase: "verifying" } }));
    await executeField(get, set, runId, field, suites, "runs");
    await runMutationOracle(get, set, field, suites);
  }
  if (!councilAlive(get().council, runId)) {
    set({ running: false });
    void get().persistRun();
    return;
  }

  // ---------------------------------------------------------- round 2: review
  set((st) => ({ council: { ...st.council, phase: "reviewing" } }));
  const exec1 = [executionDigest(field, get().council.runs), oracleDigest(get().council.oracles)]
    .filter(Boolean)
    .join("\n\n");
  const docket1 = candidateDocket(field);
  const reviewSlots: CouncilSlot[] = field.map((c) => ({
    id: `council-review:${c.letter}`,
    kind: "review",
    model: c.model,
    status: "idle",
    text: "",
    error: null,
    attemptId: null,
    elapsedMs: null,
  }));
  set((st) => ({ council: { ...st.council, slots: reviewSlots } }));
  await Promise.all(
    reviewSlots.map((slot, i) =>
      wait(i * COUNCIL_STEP_MS).then(() => {
        if (!councilAlive(get().council, runId)) return null;
        return runCouncilSlot(
          get,
          set,
          slot,
          {
            model: slot.model,
            endpoint: endpointForModel(settings, slot.model),
            systemPrompt: reviewSystemPrompt(),
            userText: reviewUserPrompt({ question: problem, docket: docket1, execution: exec1, knowledge }),
            images: [],
            maxTokens: settings.maxTokens,
            temperature: 0,
          },
          settings
        );
      })
    )
  );
  const reviewSets: ReviewSet[] = get()
    .council.slots.filter((x) => x.kind === "review" && x.status === "done")
    .map((x) => parseReviewSet(x.text, x.model));
  set((st) => ({ council: { ...st.council, reviews: reviewSets } }));

  // --------------------------------------------------------- round 3: revise
  //
  // Reviews empty or all-unparsed means the council has nothing new to teach
  // its solvers, and a revision round over zero critiques is ten requests
  // spent re-answering the question they already answered.
  if (reviewSets.some((r) => r.reviews.length > 0)) {
    set((st) => ({ council: { ...st.council, phase: "revising" } }));
    const reviseSlots: CouncilSlot[] = field.map((c) => ({
      id: `council-revise:${c.letter}`,
      kind: "revise",
      model: c.model,
      status: "idle",
      text: "",
      error: null,
      attemptId: null,
      elapsedMs: null,
    }));
    set((st) => ({ council: { ...st.council, slots: reviseSlots } }));
    await Promise.all(
      reviseSlots.map((slot, i) =>
        wait(i * COUNCIL_STEP_MS).then(() => {
          if (!councilAlive(get().council, runId)) return null;
          const c = field.find((f) => f.letter === slot.id.split(":")[1])!;
          const received = reviewsOf(reviewSets, c.letter)
            .map((r) => `- [${r.reviewer}] correct: ${r.correct}. ${r.problems}`)
            .join("\n");
          return runCouncilSlot(
            get,
            set,
            slot,
            {
              model: slot.model,
              endpoint: endpointForModel(settings, slot.model),
              systemPrompt: reviseSystemPrompt(),
              userText: reviseUserPrompt({
                question: problem,
                letter: c.letter,
                ownRaw: c.final?.raw ?? c.text,
                docket: docket1,
                received,
                execution: exec1,
                knowledge,
              }),
              images: [],
              maxTokens: settings.maxTokens,
              temperature: 0,
            },
            settings
          );
        })
      )
    );
    // Fold revisions into the field. A malformed revision is not silently
    // adopted: the original stays the candidate and the gate sees it.
    const withRevisions = field.map((c) => {
      const rev = get().council.revisions[c.letter];
      if (!rev) return c;
      const parsed = parseFinal(rev.text);
      return { ...c, revised: parsed ?? c.final, revisedText: rev.text };
    });
    set((st) => ({ council: { ...st.council, candidates: withRevisions } }));

    if (suites.length) {
      set((st) => ({ council: { ...st.council, phase: "reverifying" } }));
      await executeField(get, set, runId, withRevisions, suites, "revisedRuns");
    }
  }

  if (!councilAlive(get().council, runId)) {
    set({ running: false });
    void get().persistRun();
    return;
  }

  // ---------------------------------------------------------- round 4: judge
  set((st) => ({ council: { ...st.council, phase: "judging" } }));
  const fieldNow = get().council.candidates;
  const docketBoth =
    candidateDocket(fieldNow) +
    (fieldNow.some((c) => c.revised) ? "\n\n=== REVISED ===\n\n" + candidateDocket(fieldNow, { revised: true }) : "");
  const suspectHarness = [
    harnessIsSuspect(get().council.runs),
    oracleSuspicion(get().council.oracles),
  ]
    .filter(Boolean)
    .join("\n\n");
  const execBoth = [
    executionDigest(fieldNow, get().council.runs),
    fieldNow.some((c) => c.revised)
      ? "=== REVISED RUNS ===\n" + executionDigest(fieldNow, get().council.revisedRuns, { revised: true })
      : "",
    oracleDigest(get().council.oracles),
    // Independent solutions do not usually fail in the same place. When they do,
    // the judges should hear that before they read the scores, not after.
    suspectHarness ? `NOTE ON THE HARNESS: ${suspectHarness}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const reviewsDigest = reviewSets
    .map((r) => `Reviewer ${r.reviewer.slice(0, 30)}… best ${r.best || "?"}, worst ${r.worst || "?"}\n${r.raw}`)
    .join("\n\n");

  const bench = selectAdaptiveJudges(settings.councilJudges, seat => seat.model,
    route, capabilityEvidence, COUNCIL_SIZE.judgesMax).selected;
  const judgeSlots: CouncilSlot[] = bench.map((seat, i) => ({
    id: `council-judge:${i}`,
    kind: "judge",
    model: seat.model,
    emphasis: seat.emphasis,
    status: "idle",
    text: "",
    error: null,
    attemptId: null,
    elapsedMs: null,
  }));
  set((st) => ({ council: { ...st.council, slots: judgeSlots } }));
  await Promise.all(
    judgeSlots.map((slot, i) =>
      wait(i * COUNCIL_STEP_MS).then(() => {
        if (!councilAlive(get().council, runId)) return null;
        const seat = bench[Number(slot.id.split(":")[1])];
        return runCouncilSlot(
          get,
          set,
          slot,
          {
            model: seat.model,
            endpoint: endpointForModel(settings, seat.model),
            systemPrompt: judgeSystemPrompt(seat.emphasis),
            userText: judgeUserPrompt({ question: problem, docket: docketBoth, reviews: reviewsDigest, execution: execBoth, knowledge }),
            images: [],
            maxTokens: settings.maxTokens,
            temperature: 0,
          },
          settings
        );
      })
    )
  );
  const judges: JudgeReport[] = get()
    .council.slots.filter((x) => x.kind === "judge")
    .map((x, i) => ({
      model: x.model,
      emphasis: (x.emphasis ?? bench[i]?.emphasis ?? "correctness") as JudgeReport["emphasis"],
      text: x.status === "done" ? x.text : "",
      error: x.error,
    }));
  set((st) => ({ council: { ...st.council, judges } }));

  // ------------------------------------------------------- round 5: synthesize
  set((st) => ({ council: { ...st.council, phase: "synthesizing" } }));
  const synthModel = settings.synthesisModel || bench[0]?.model || fieldNow[0].model;
  let synthesis = "";
  let error: string | null = null;
  try {
    synthesis = await bridge.runOnce({
      runId,
      agentId: "council-synthesis",
      attemptId: newAttemptId(),
      provider: settings.gatewayId,
      model: synthModel,
      systemPrompt: synthesisSystemPrompt(),
      userText: synthesisUserPrompt({
        question: problem,
        docket: docketBoth,
        reviews: reviewsDigest,
        execution: execBoth,
        judges: judges.map((j) => `### ${j.model} (${j.emphasis})\n${j.text || j.error || "(no report)"}`).join("\n\n"),
        knowledge,
      }),
      images: [],
      maxTokens: settings.maxTokens,
      temperature: 0,
      baseUrl: settings.gatewayBaseUrl || gatewayPreset(settings.gatewayId).defaultBaseUrl,
      endpoint: endpointForModel(settings, synthModel),
    });
  } catch (err) {
    error = cleanError(String(err));
  }

  // The winner is read out of the synthesis, but only when the gate allows it.
  // `enforceWinnerGate` is the same function the cloud worker calls, so the two
  // paths cannot drift apart on the one rule the whole design exists to protect.
  // It is stricter than the check that used to live here in one way that
  // matters: "untested" is rejected too, not only "fail". A candidate nobody
  // could execute is unverified, and unverified is not correct — while a run
  // where *nothing* executed, an MCQ or a maths answer, still passes through,
  // because a gate with no evidence behind it must not veto anything.
  const parsedSynthesis = parseCouncilSynthesis(synthesis);
  const judgeReadings = judges.map((j) => ({
    model: j.model,
    emphasis: j.emphasis,
    error: j.error,
    ...parseJudgeReport(j.text),
  }));
  const claimedWinner = parsedSynthesis.winner;
  const gateRuns: Record<string, CandidateRun> = {};
  for (const c of fieldNow) {
    const run = c.revised ? get().council.revisedRuns[c.letter] : get().council.runs[c.letter];
    if (run) gateRuns[c.letter] = run;
  }
  const ruling = enforceWinnerGate(claimedWinner, gateRuns);
  // The same deterministic layer the cloud worker runs: the gate decides what
  // may win, the judges' counted scoreboard decides between what is left, and
  // the synthesis narrates a result it no longer gets to choose. Both paths
  // call one function so the app and the helper cannot drift on the winner.
  const decision = decideWinner({
    claimed: claimedWinner,
    judges: judgeReadings,
    runs: gateRuns,
    letters: fieldNow.map((c) => c.letter),
  });
  const winner = decision.winner;
  if (ruling.overruledReason) {
    synthesis = `${synthesis}\n\n---\n\n**GATE OVERRULE.** ${ruling.overruledReason}`;
  }
  if (decision.disagreement) {
    synthesis = `${synthesis}\n\n---\n\n**JUDGE AGGREGATE.** ${decision.disagreement}`;
  }
  const dossier: CouncilDossier = {
    synthesis: parsedSynthesis,
    judges: judgeReadings,
    tally: decision.tally,
    winnerSource: decision.source,
    disagreement: decision.disagreement,
  };

  set((st) => ({
    council: { ...st.council, phase: error ? "error" : "done", synthesis, winner, dossier, error },
    running: false,
  }));
  void get().persistRun();
}

/**
 * The gate the synthesis answer must clear, stated where the pipeline ends so
 * it is the last thing read rather than a paragraph nobody scrolls back to:
 * an AI consensus never overrides an objective failure. `winner` filtering
 * above enforces it for the record; this is the docstring that says why.
 */

/**
 * The council-slot stale check, kept separate from `isStale` because a slot's
 * lifecycle is not a pane's: a revision slot is done the moment it is folded
 * into the field, and a late delta dropping onto it afterwards must not pull
 * the whole council back to "revising".
 */
function isStaleCouncil(s: State, slot: CouncilSlot, attemptId: string): boolean {
  if (!councilAlive(s.council, s.council.runId ?? "")) return true;
  if (slot.attemptId !== attemptId) return true;
  return slot.status !== "queued" && slot.status !== "streaming";
}

/**
 * Events are broadcast app-wide with no delivery ordering guarantee, so a reply
 * from a run the user already stopped — or from the request a rerun replaced —
 * can still land here. Without this check it overwrites the pane that has since
 * moved on, and the "still going" bookkeeping starts counting the wrong run.
 */
function isStale(s: State, e: { agentId: string; attemptId: string }): boolean {
  const agent = s.agents.find((a) => a.id === e.agentId);
  if (!agent) return true;
  // Attempt ids are globally unique, so this subsumes a run id comparison and
  // additionally separates a rerun from the launch it replaced -- which a run id
  // cannot do, because a rerun deliberately keeps the same one.
  if (agent.attemptId !== e.attemptId) return true;
  return agent.status !== "queued" && agent.status !== "streaming";
}

if (typeof window !== "undefined") {
  window.setTimeout(() => publishOverlayState(useStore.getState()), 0);
}
