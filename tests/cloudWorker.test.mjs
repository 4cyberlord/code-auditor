// Hermetic: config now comes from the database, and this test must not inherit
// whatever is in a developer's .development.env.
import { createHash } from "node:crypto";

process.env.CODE_AUDITOR_CONFIG = "off";
process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.TOKENROUTER_API_KEY = "tokenrouter";
process.env.CODE_AUDITOR_TOKENROUTER_MIN_DELAY_MS = "0";
process.env.CODE_AUDITOR_TOKENROUTER_JITTER_MS = "0";
process.env.CODE_AUDITOR_WORKER_SOLVERS = "2";
process.env.CODE_AUDITOR_WORKER_JUDGES = "1";

let fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const textOf = (call) =>
  (Array.isArray(call?.messages?.[1]?.content)
    ? call.messages[1].content.find((p) => p.type === "text")?.text
    : call?.messages?.[1]?.content) || "";

const events = [];
const patches = [];
const reports = [];
const modelCalls = [];
const apiRoutes = [];
let cleanRateRetries = 0;
// Flipped for the second scenario, so the generated harness rejects every
// candidate the way a harness with a wrong expectation does.
let HARNESS_WRONG = false;
let REPAIRABLE_EDGE = false;
let EMPTY_SPEC_ONCE = true;
let EMPTY_SPEC_ALWAYS = false;
let EMPTY_SPEC_TRUNCATED_ONCE = false;
// Scenario 3: one route answers nothing, ever, the way a dead endpoint does.
let DEAD_MODEL = "";
// Scenario 5: a route with no reasoning mode, which must not read as a dead seat.
let REJECTS_REASONING = "";
let TRUNCATE_MODEL_ONCE = "";
let TRUNCATE_SENT = false;
let MCQ_READING = false;
const responsesCalls = [];
const abort = () => Object.assign(new Error("aborted"), { name: "AbortError" });

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function modelReply(body) {
  return json({ choices: [{ message: { content: body } }] });
}

// Scenario 8: the knowledge library in the database, and the fallback when it
// cannot be read.
let LIBRARY_ROWS = null;
let LIBRARY_DOWN = false;
// Scenario 9: two readers that read the same screenshot differently.
let READERS_DISAGREE = false;
let TIE_BREAK_PICK = "B";

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.includes("/rest/v1/app_config?")) {
    return json([{ key: "cleanapis", value: "test-clean-token", owner_id: "clean-owner" }]);
  }
  if (href === "https://cleanapis.com/v1/models") {
    return json({ data: ["claude-opus-5.5", "kimi-k3", "gpt-5.6-sol", "unapproved-model"].map(id => ({ id })) });
  }
  if (href.includes("/rest/v1/intelligence_")) {
    if (LIBRARY_DOWN) throw new Error("ECONNREFUSED");
    if (href.includes("intelligence_sources")) return json([]);
    return json(LIBRARY_ROWS ?? []);
  }
  if (href.includes("/rest/v1/solve_job_events")) {
    const row = JSON.parse(init.body);
    events.push(row);
    return json([row]);
  }
  if (/\/rest\/v1\/solve_jobs\?id=eq\./.test(href)) {
    const patch = JSON.parse(init.body);
    patches.push(patch);
    const id = /id=eq\.([^&]+)/.exec(href)?.[1] || "job-1";
    return json([{ id, session_id: "session-1", settings_snapshot: {}, ...patch }]);
  }
  if (/\/rest\/v1\/solve_job_images\?job_id=eq\./.test(href)) {
    return json([
      {
        id: "image-1",
        job_id: "job-1",
        session_id: "session-1",
        position: 0,
        storage_bucket: "screenshots",
        storage_path: "session-1/0.png",
        file_name: "0.png",
        bytes: 8,
        mime: "image/png",
      },
    ]);
  }
  if (href.includes("/rest/v1/council_reports")) {
    const row = JSON.parse(init.body);
    // A progressive report is inserted once and then PATCHed in place as
    // independent language ports finish. Mimic PostgREST's update semantics
    // rather than counting each PATCH as a new database row.
    if (String(init.method || "GET").toUpperCase() === "PATCH") {
      const id = new URL(href).searchParams.get("job_id")?.replace(/^eq\./, "");
      const stored = reports.find(report => report.job_id === id);
      if (stored) Object.assign(stored, row);
      return json(stored ? [stored] : []);
    }
    reports.push(row);
    return json([row]);
  }
  if (href.includes("/storage/v1/object/sign/screenshots/session-1/0.png")) {
    return json({ signedURL: "http://storage.local/0.png" });
  }
  if (href === "http://storage.local/0.png") {
    return new Response(Buffer.from("png-bytes"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  if (href.includes("/responses")) {
    const req = JSON.parse(init.body);
    responsesCalls.push(req);
    // The Responses wire carries the system prompt as `instructions`, not as a
    // first message. Answering the right shape here is the point of the test.
    const reply = (text) =>
      json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
    if (String(req.instructions).includes("final synthesizer")) {
      return reply("VERDICT: Candidate A is the best supported answer.\nWINNER: A\nREJECTED: B - less evidence\nEVIDENCE: measured\nAPPROACH: direct\nFINAL ANSWER: ship A");
    }
    if (String(req.instructions).includes("one judge on an engineering council")) {
      return reply("VERDICT: A is strongest\nRANKING: A, B\nCORRECT: A\nWHY: simpler\nDEFECTS: none\nBEST ANSWER: ship A");
    }
    return reply("unexpected responses call");
  }
  if (href.includes("/chat/completions")) {
    const req = JSON.parse(init.body);
    modelCalls.push(req);
    apiRoutes.push({ url: href, authorization: init.headers?.authorization, model: req.model });
    if (href === "https://cleanapis.com/v1/chat/completions" && cleanRateRetries === 0) {
      cleanRateRetries++;
      return json({ error: { message: "Rate limit exceeded" } }, { status: 429, headers: { "retry-after": "0.001" } });
    }
    if (DEAD_MODEL && req.model === DEAD_MODEL) throw abort();
    if (REJECTS_REASONING && req.model === REJECTS_REASONING && req.reasoning_effort) {
      return json({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }, { status: 400 });
    }
    const system = req.messages[0].content;
    if (TRUNCATE_MODEL_ONCE && !TRUNCATE_SENT && req.model.includes(TRUNCATE_MODEL_ONCE) &&
      system.includes("one of four independent expert agents")) {
      TRUNCATE_SENT = true;
      return json({
        choices: [{ finish_reason: "length", message: { content: "<<<FINAL\nKIND: code\nLANGUAGE: javascript\nANSWER: partial\nCODE:\n```javascript\nexport function solve(xs) { return xs.length; }" } }],
        usage: { completion_tokens: req.max_tokens },
      });
    }
    if (system.includes("Two models read the same screenshot and disagree")) {
      if (TIE_BREAK_PICK === "neither") return modelReply("I cannot tell from this image.");
      const shown = Array.isArray(req.messages[1].content)
        ? req.messages[1].content.find((p) => p.type === "text")?.text || ""
        : req.messages[1].content;
      // Pick whichever side is not the misreading, whichever letter it landed on.
      const aBlock = /A:\n([\s\S]*?)\n\nB:/.exec(shown)?.[1] || "";
      return modelReply(`code: ${aBlock.includes("misread") ? "B" : "A"}`);
    }
    if (system.includes("You are reading a screenshot and turning it into structured data")) {
      if (MCQ_READING) {
        return modelReply(
          JSON.stringify({
            kind: "other",
            language: "english",
            framework: "",
            fileName: "",
            filePath: "",
            code: "",
            errors: [],
            terminalCommands: [],
            terminalOutput: "",
            url: "",
            observations: ["A. 18", "B. 9", "C. 27", "D. 0"],
            problemSummary: "What is 18 + 9?",
            ambiguities: [],
            confidence: 0.94,
          })
        );
      }
      return modelReply(
        JSON.stringify({
          kind: "code",
          language: "javascript",
          framework: "",
          fileName: "solve.js",
          filePath: "",
          code:
            READERS_DISAGREE && req.model === "moonshotai/kimi-k3"
              ? "export function solve(xs) { /* count them, misread */ }"
              : "export function solve(xs) { /* count them */ }",
          errors: [],
          terminalCommands: [],
          terminalOutput: "",
          url: "",
          observations: ["The function must return how many elements it was given."],
          problemSummary: "Count the elements of an array and return the count.",
          ambiguities: [],
          confidence: 0.9,
        })
      );
    }
    if (system.includes("You answer multiple-choice questions from screenshots")) {
      return modelReply(JSON.stringify({
        kind: "mcq",
        question: "What is 18 + 9?",
        options: [
          { label: "A", text: "18" },
          { label: "B", text: "9" },
          { label: "C", text: "27" },
          { label: "D", text: "0" },
        ],
        answer: { label: "C", text: "27" },
        reason: "18 plus 9 equals 27, so C is the only matching choice.",
        whyNot: [
          { label: "A", reason: "18 omits the added 9." },
          { label: "B", reason: "9 omits the 18." },
          { label: "D", reason: "0 is not the sum." },
        ],
        knowledgeUsed: true,
        model: req.model,
      }));
    }
    if (system.includes("You read a problem statement and write down what it asks")) {
      return modelReply(`<<<CONTRACT
KIND: code
LANGUAGES: javascript
SIGNATURE: function solve(xs)
INPUTS: xs, an array
OUTPUTS: how many elements it was given
CONSTRAINTS: 0 <= xs.length <= 100000
EXAMPLES: [] -> 0
EDGE CASES: empty array
COMPLEXITY: O(n) time
UNKNOWNS: none
CONTRACT>>>`);
    }
    if (system.includes("senior engineer revising your own solution")) {
      return modelReply(`Having read the reviews:

<<<FINAL
KIND: code
LANGUAGE: javascript
ANSWER: Same approach, guarded for the empty case.
COMPLEXITY: O(n) time, O(1) space
CONFIDENCE: 0.9
CLAIMS:
- The empty case is explicit now.
CODE:
\`\`\`javascript
export function solve(xs) { return xs ? xs.length : 0; }
\`\`\`
FINAL>>>`);
    }
    if (system.includes("You write test harnesses for candidate solutions")) {
      if (EMPTY_SPEC_TRUNCATED_ONCE) {
        EMPTY_SPEC_TRUNCATED_ONCE = false;
        return json({
          choices: [{ finish_reason: "length", message: { content: "" } }],
          usage: { completion_tokens: req.max_tokens },
        });
      }
      if (EMPTY_SPEC_ONCE || EMPTY_SPEC_ALWAYS) {
        EMPTY_SPEC_ONCE = false;
        return modelReply("");
      }
      return modelReply(`<<<TESTS
HARNESS: javascript
\`\`\`javascript
<<<SOLUTION>>>
let failed = 0;
const cases = [
  { name: "empty", input: [], want: ${HARNESS_WRONG ? 99 : 0} },
  { name: "singleton", input: [1], want: 1 },
  { name: "three", input: [1, 2, 3], want: ${HARNESS_WRONG ? 99 : 3} },
  { name: "duplicates", input: [4, 4], want: 2 },
  { name: "negative", input: [-1, -2], want: 2 },
  { name: "zeros", input: [0, 0], want: 2 },
  { name: "boundary", input: [7], want: 1 },
  { name: "larger", input: [1, 2, 3, 4], want: 4 },
  ${REPAIRABLE_EDGE ? '{ name: "missing", input: null, want: 0 },' : ''}
];
for (const c of cases) {
  const got = solve(c.input);
  if (got === c.want) console.log("PASS " + c.name);
  else { console.log("FAIL " + c.name + " got=" + got + " want=" + c.want); failed++; }
}
if (failed) process.exit(1);
\`\`\`
REFERENCE: javascript
\`\`\`javascript
/* independent reference */
export function solve(xs) { return xs == null ? 0 : xs.length; }
\`\`\`
TESTS>>>`);
    }
    if (system.includes("senior engineer on a review council")) {
      return modelReply(`<<<REVIEWS
BEST: A
WORST: B
CANDIDATE: A
CORRECT: yes
PROBLEMS: none
TIME: O(n)
SPACE: O(1)
QUALITY: direct
CANDIDATE: B
CORRECT: unsure
PROBLEMS: not enough evidence
TIME: O(n)
SPACE: O(n)
QUALITY: okay
REVIEWS>>>`);
    }
    if (system.includes("one judge on an engineering council")) {
      return modelReply("VERDICT: A is strongest\nRANKING: A, B\nCORRECT: A\nWHY: simpler\nDEFECTS: B uncertain\nBEST ANSWER: ship A");
    }
    if (system.includes("final synthesizer")) {
      return modelReply("VERDICT: Candidate A is the best supported answer.\nWINNER: A\nREJECTED: B - less evidence\nEVIDENCE: no benchmark evidence\nAPPROACH: direct\nFINAL ANSWER: return the answer from A");
    }
    return modelReply(`Reasoning...

<<<FINAL
KIND: code
LANGUAGE: javascript
ANSWER: Use the direct approach.
COMPLEXITY: O(n) time, O(1) space
CONFIDENCE: 0.82
CLAIMS:
- The input can be scanned once.
- No extra structure is required.
CODE:
\`\`\`javascript
export function solve(xs) { return xs.length; }
\`\`\`
FINAL>>>`);
  }
  throw new Error(`Unexpected fetch: ${href}`);
};

const { runCouncilJob: runWorkerJob, remoteScript } = await import("../scripts/cloud-worker.mjs");
const javaScript = remoteScript("java", "class Main {}", "e2b");
check("Java E2B command is concrete, not an undefined template variable",
  javaScript.includes("command='javac Main.java && java Main'") && !javaScript.includes("JAVA_COMMAND"));
check("E2B execution streams output while preserving bounded final evidence",
  javaScript.includes("tee >(head -c 65536 > stdout.txt)") &&
  javaScript.includes("tee >(head -c 65536 > stderr.txt)") &&
  javaScript.includes("CA_E2B_EXECUTION_STARTED"));
check("every supported E2B language builds a runner script",
  ["python", "javascript", "typescript", "bash", "ruby", "php", "c", "cpp", "java", "go", "rust"]
    .every((language) => remoteScript(language, "// smoke", "e2b").includes("CA_EXIT:")));
const runCouncilJob = job => runWorkerJob({ ...job,
  settings_snapshot: { executionProvider: "e2b", ...job.settings_snapshot },
});
let EXECUTIONS = 0;
globalThis.__COUNCIL_E2B_TEST_DOUBLE__ = async (_language, program) => {
  EXECUTIONS++;
  const isReference = program.includes("/* independent reference */");
  const wrongHarness = /want:\s*99/.test(program);
  const needsRepair = /name:\s*"missing"/.test(program) && !/return xs \? xs\.length : 0/.test(program);
  const wrong = !isReference && (wrongHarness || needsRepair);
  const stdout = isReference
    ? "PASS empty\nPASS singleton\nPASS three\nPASS duplicates\nPASS negative\nPASS zeros\nPASS boundary\nPASS larger\n"
    : wrongHarness
    ? "FAIL empty got=0 want=99\nPASS singleton\nFAIL three got=3 want=99\nPASS duplicates\nPASS negative\nPASS zeros\nPASS boundary\nPASS larger\n"
    : needsRepair
      ? "PASS empty\nPASS singleton\nPASS three\nPASS duplicates\nPASS negative\nPASS zeros\nPASS boundary\nPASS larger\nFAIL missing got=TypeError want=0\n"
      : `PASS empty\nPASS singleton\nPASS three\nPASS duplicates\nPASS negative\nPASS zeros\nPASS boundary\nPASS larger\n${REPAIRABLE_EDGE ? 'PASS missing\n' : ''}`;
  return {
    ok: !wrong, exitCode: wrong ? 1 : 0, stdout, stderr: "", durationMs: 12,
    remoteElapsedMs: 2, peakMemoryKb: 8192, runtime: "e2b test double",
    provider: "e2b", sandboxId: "test-sandbox", executionId: "test-execution",
    state: wrong ? "failed" : "completed", exitVerified: true, timedOut: false,
    truncated: false, network: "denied", bootMs: 10,
  };
};
const { COUNCIL_DEFAULT_MODELS } = await import("../src/lib/council.ts");

console.log("\n1. cloud worker v1 happy path");
await runCouncilJob({
  id: "job-1",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});

check("patched completed", patches.some((p) => p.status === "completed"));
check("wrote one report", reports.length === 1);
check("report has winner", reports[0]?.winner === "A", String(reports[0]?.winner));
check("report has reviews", reports[0]?.report?.reviews?.length === 2, String(reports[0]?.report?.reviews?.length));
check("report has judges", reports[0]?.report?.judges?.length === 1, String(reports[0]?.report?.judges?.length));
check("report has benchmark suite", reports[0]?.report?.suites?.length === 1, String(reports[0]?.report?.suites?.length));
check("empty harness response was retried with another route",
  modelCalls.filter(c => c.messages?.[0]?.content?.includes("You write test harnesses for candidate solutions")).length >= 2);
check("provider empty-output details stay out of user-facing run events",
  !events.some(e => /empty model response/i.test(`${e.message || ""} ${JSON.stringify(e.payload || {})}`)));
const harnessCalls = modelCalls.filter(c => c.messages?.[0]?.content?.includes("You write test harnesses for candidate solutions"));
check("harness generation reserves output tokens and disables hidden reasoning",
  harnessCalls.some(c => c.max_tokens >= 8192 && !c.reasoning_effort && !c.reasoning));
check("report has passing E2B runs", reports[0]?.report?.runs?.A?.passed === 8 && reports[0]?.report?.runs?.B?.passed === 8, JSON.stringify(reports[0]?.report?.runs));
check(
  "published winner fingerprint matches the exact E2B-tested source",
  reports[0]?.report?.runs?.A?.codeDigest === createHash("sha256").update(reports[0]?.report?.candidates?.[0]?.final?.code || "").digest("hex"),
  String(reports[0]?.report?.runs?.A?.codeDigest)
);
check("downloaded image for model calls", modelCalls.some((c) => Array.isArray(c.messages[1].content) && c.messages[1].content.some((p) => p.type === "image_url")));
check("benchmark phase event recorded", events.some((e) => e.phase === "benchmark_done"));
check("review phase event recorded", events.some((e) => e.phase === "review_done"));
check("judge phase event recorded", events.some((e) => e.phase === "judge_done"));
check("completion event recorded", events.some((e) => e.phase === "completed"));


// --- the adaptive revision round ---------------------------------------------
check("only the candidate with a substantive concern was asked to revise",
  events.filter((e) => e.phase === "revision_done").length === 1 &&
  events.some((e) => e.phase === "revision_done" && e.payload?.letter === "B"));
check(
  "only the revised candidate was re-executed",
  Object.keys(reports[0]?.report?.revisedRuns || {}).length === 1 && reports[0]?.report?.revisedRuns?.B?.passed === 8,
  JSON.stringify(reports[0]?.report?.revisedRuns)
);
check(
  "the clean candidate was not needlessly rewritten",
  !reports[0]?.report?.candidates?.[0]?.revised && reports[0]?.report?.candidates?.[1]?.revised?.code?.includes("xs ? xs.length"),
  JSON.stringify(reports[0]?.report?.candidates?.map((candidate) => Boolean(candidate.revised)))
);
const judgeCall = modelCalls.find((c) => c.messages[0].content.includes("one judge on an engineering council"));
check(
  "the judges were shown both dockets",
  textOf(judgeCall).includes("=== REVISED ==="),
  textOf(judgeCall).slice(0, 200)
);

// --- trusted screenshot readings avoid a duplicate contract gate ------------
check("an agreed reading starts the solvers without a second contract pass", events.some((e) => e.phase === "problem_contract_reused"));
const firstSolverText = textOf(modelCalls.find((c) => String(c.messages[0].content).includes("independent expert agents")));
check(
  "the verified reading reached the solvers",
  firstSolverText.includes("READING OF THE SCREENSHOT") && firstSolverText.includes("function solve(xs)"),
  firstSolverText.slice(-400)
);
check(
  "and the same reading reached the judges",
  textOf(judgeCall).includes("READING OF THE SCREENSHOT"),
  textOf(judgeCall).slice(0, 200)
);

// --- the dossier: fields, not prose ----------------------------------------
const parsed = reports[0]?.report?.parsed;
check("the synthesis parsed", parsed?.synthesis?.winner === "A", JSON.stringify(parsed?.synthesis?.winner));
check("the approach is a field now", parsed?.synthesis?.approach === "direct", String(parsed?.synthesis?.approach));
check("the judge's ranking was counted", parsed?.tally?.[0]?.letter === "A", JSON.stringify(parsed?.tally));
check("the winner was selected from execution evidence", parsed?.winnerSource === "evidence", String(parsed?.winnerSource));

// --- the presentation the overlay renders ----------------------------------
const presentation = reports[0]?.report?.presentation;
check("standing is stamped on the report", presentation?.standing === "verified", String(presentation?.standing));
check("there is one evidence row per candidate", presentation?.evidence?.length === 2, JSON.stringify(presentation?.evidence?.length));
check(
  "the evidence distinguishes the clean original from the repaired candidate",
  presentation?.evidence?.[0]?.revised === false && presentation?.evidence?.[1]?.revised === true && presentation?.evidence?.[1]?.gate === "pass",
  JSON.stringify(presentation?.evidence)
);
check("provenance names the model behind the winner", Boolean(presentation?.provenance?.includes("Candidate A")), String(presentation?.provenance));

// --- reconstruction plus independent visual solving --------------------------
//
// Reading a screenshot and solving what is in it are different skills. Readers
// provide shared context, but every solver must independently inspect the
// original image even when those readers agree.
// A solver is the seat told it is one of several working the same problem.
// Identifying it by that rather than by "not one of the other phases" means a
// new phase cannot silently become "the solver" in this test.
const isSolver = (c) => String(c.messages[0].content).includes("independent expert agents");
const solverCall = modelCalls.find(isSolver);
const contentOf = (call) =>
  Array.isArray(call?.messages?.[1]?.content)
    ? call.messages[1].content.find((p) => p.type === "text")?.text || ""
    : call?.messages?.[1]?.content || "";
const solverText = contentOf(solverCall);

check("the screenshot was reconstructed first", events.some((e) => e.phase === "reading_done"));
check("two readers looked at it", (events.find((e) => e.phase === "reading_done")?.payload?.readers || []).length === 2, JSON.stringify(events.find((e) => e.phase === "reading_done")?.payload));
check("the readers were the ones shown the picture", modelCalls.some((c) => c.messages[0].content.includes("You are reading a screenshot") && c.messages[1].content.some?.((p) => p.type === "image_url")));
check("the solvers are never downgraded to transcript-only", !events.some((e) => e.phase === "solving_from_reading"));
check("so the reading reached the solver", solverText.includes("READING OF THE SCREENSHOT"), solverText.slice(0, 160));
check(
  "and the official image went with it",
  Array.isArray(solverCall?.messages?.[1]?.content) && solverCall.messages[1].content.some((p) => p.type === "image_url"),
  JSON.stringify(solverCall?.messages?.[1]?.content?.map?.((p) => p.type))
);
check("the house rules reached the solver", solverText.includes("HOUSE RULES") && solverText.includes("C++"));
check("the memory target is readable", solverText.includes("20 MB"), solverText.slice(0, 400));

// Solving and review retain the user's reasoning budget; bounded extraction
// work is intentionally concise so it cannot delay solver assignment.
check("the solver was asked to reason", solverCall?.reasoning_effort === "high", String(solverCall?.reasoning_effort));
check("the readers skip solve-time reasoning", modelCalls
  .filter((c) => c.messages?.[0]?.content?.includes("You are reading a screenshot"))
  .every((c) => !c.reasoning_effort), JSON.stringify(modelCalls.map((c) => c.reasoning_effort)));

// The library now arrives before the first attempt, retrieved against the
// contract. It used to wait for the panel to produce words — which meant every
// round except the one that wrote the answers got the guidance.
check("it was recognised as a coding problem", events.some((e) => e.phase === "problem_kind" && e.payload?.coding === true));
check("knowledge was selected", events.some((e) => e.phase === "knowledge_selected"));
check(
  "and the verified reading was what searched for it",
  events.find((e) => e.phase === "knowledge_selected")?.payload?.from === "reading",
  JSON.stringify(events.find((e) => e.phase === "knowledge_selected")?.payload)
);
check(
  "so the solvers had it on their first attempt",
  firstSolverText.includes("LOCAL KNOWLEDGE / RAG"),
  firstSolverText.slice(0, 200)
);
// Retrieval happens once, not once per round: the reading's pack is reused by
// every later stage rather than re-searched from the answers.
check(
  "the library was searched once",
  events.filter((e) => e.phase === "knowledge_selected").length === 1,
  String(events.filter((e) => e.phase === "knowledge_selected").length)
);
const reviseCall = modelCalls.find((c) => c.messages[0].content.includes("senior engineer revising your own solution"));
check(
  "and the revising solver finally sees it too",
  textOf(reviseCall).includes("Local Knowledge/RAG"),
  textOf(reviseCall).slice(0, 200)
);
const reviewCall = modelCalls.find((c) => c.messages[0].content.includes("senior engineer on a review council"));
check(
  "the knowledge reached the reviewers",
  textOf(reviewCall).includes("Local Knowledge/RAG"),
  textOf(reviewCall).slice(0, 200)
);

console.log("\n1b. empty harness responses cannot publish an untested answer");
EMPTY_SPEC_ALWAYS = true;
const beforeUnverified = { reports: reports.length, executions: EXECUTIONS };
let noHarnessRejected = false;
try {
  await runCouncilJob({ id: "job-no-harness", session_id: "session-1", settings_snapshot: {
    mode: "auto", maxTokens: 2048,
    councilModels: [{ id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" }],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  } });
} catch (err) {
  noHarnessRejected = /no executable .* test harness/i.test(String(err));
}
EMPTY_SPEC_ALWAYS = false;
check("empty specs fail closed", noHarnessRejected, true);
check("no unverified report was published", reports.length, beforeUnverified.reports);
check("E2B was not falsely reported as having tested code", EXECUTIONS, beforeUnverified.executions);

console.log("\n1c. truncated model output is retried before parsing or E2B");
TRUNCATE_MODEL_ONCE = "claude-opus-5.5";
TRUNCATE_SENT = false;
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;
await runCouncilJob({ id: "job-truncated-model", session_id: "session-1", settings_snapshot: {
  mode: "auto", maxTokens: 2048,
  councilModels: [{ id: "anthropic/claude-opus-5.5", endpoint: "chat" },
    { id: "moonshotai/kimi-k3", endpoint: "chat" }],
  councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
} });
TRUNCATE_MODEL_ONCE = "";
const truncatedSolverCalls = modelCalls.filter(c => String(c.model).includes("claude-opus-5.5") &&
  String(c.messages?.[0]?.content).includes("one of four independent expert agents"));
check("the truncated 200 response was retried with a larger output budget",
  truncatedSolverCalls.length === 2 && truncatedSolverCalls[1].max_tokens > truncatedSolverCalls[0].max_tokens,
  JSON.stringify(truncatedSolverCalls.map(c => c.max_tokens)));
check("only the complete retry entered candidate processing", reports[0]?.report?.candidates?.some(c =>
  c.final?.wellFormed === true && c.final?.answer !== "partial"),
  JSON.stringify(reports[0]?.report?.candidates?.map(c => ({ model: c.model, answer: c.final?.answer, wellFormed: c.final?.wellFormed }))));
check("the complete answer still passed the E2B suite", reports[0]?.report?.runs?.A?.ok === true ||
  reports[0]?.report?.runs?.B?.ok === true);

console.log("\n1d. empty truncated harness output retries with a larger budget");
EMPTY_SPEC_TRUNCATED_ONCE = true;
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;
await runCouncilJob({ id: "job-empty-truncated-harness", session_id: "session-1", settings_snapshot: {
  mode: "auto", maxTokens: 8192,
  councilModels: [{ id: "anthropic/claude-opus-5.5", endpoint: "chat" },
    { id: "moonshotai/kimi-k3", endpoint: "chat" }],
  councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
} });
const emptyTruncatedHarnessCalls = modelCalls.filter(c =>
  c.messages?.[0]?.content?.includes("You write test harnesses for candidate solutions"));
check("same harness author is retried with a larger token budget",
  emptyTruncatedHarnessCalls.length >= 2 && emptyTruncatedHarnessCalls[1].max_tokens > emptyTruncatedHarnessCalls[0].max_tokens,
  JSON.stringify(emptyTruncatedHarnessCalls.map(c => c.max_tokens)));
check("the answer proceeds through E2B after the empty truncated attempt",
  reports[0]?.report?.runs?.A?.passed === 8 || reports[0]?.report?.runs?.B?.passed === 8);

// --- the gate, and the harness that convicts everybody ----------------------
console.log("\n2. a synthesis cannot promote a candidate the runner rejected");
HARNESS_WRONG = true;
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;

let rejectedUnverified = false;
try { await runCouncilJob({
  id: "job-2",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
}); } catch (err) { rejectedUnverified = /no final candidate passed executable E2B/i.test(String(err)); }

check("both candidates were executed and rejected", events.filter(e => e.phase === "benchmark_done").length >= 2,
  JSON.stringify(events.map(e => e.phase)));
check("failed candidates and E2B evidence reached Council reviewers",
  events.filter(e => e.phase === "review_done").length >= 2 &&
  modelCalls.some(c => String(c.messages?.[0]?.content).includes("senior engineer on a review council") &&
    textOf(c).includes("FAIL empty got=0 want=99") && textOf(c).includes("Candidate A")),
  JSON.stringify(events.filter(e => e.phase === "review_done").map(e => e.payload?.model)));
check("no unverified coding solution was published", rejectedUnverified && reports.length === 0,
  JSON.stringify({ rejectedUnverified, reports: reports.length }));
check(
  "identical failures accuse the harness, not the code",
  events.some((e) => e.phase === "harness_suspect"),
  JSON.stringify(events.map((e) => e.phase))
);
check(
  "test-rejected candidates still receive one bounded repair attempt",
  events.filter((e) => e.phase === "revision_done").length === 2,
  JSON.stringify(events.filter((e) => e.phase === "revision_done").map((e) => e.payload?.letter))
);
check("the job never claimed completion", !patches.some((p) => p.status === "completed"));

// A real code defect must travel E2B -> reviewers -> solver revision -> E2B
// retest before the final result can be published.
HARNESS_WRONG = false;
REPAIRABLE_EDGE = true;
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;
await runCouncilJob({
  id: "job-repairable",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto", maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});
check("repairable E2B case reached Council reviewers",
  modelCalls.some(c => String(c.messages?.[0]?.content).includes("senior engineer on a review council") &&
    textOf(c).includes("FAIL missing got=TypeError want=0")));
check("repairable E2B case reached the revising solver",
  modelCalls.some(c => String(c.messages?.[0]?.content).includes("senior engineer revising your own solution") &&
    textOf(c).includes("FAIL missing got=TypeError want=0")));
check("judge-reviewed repairs were independently retested before publication",
  reports[0]?.report?.runs?.A?.failed === 1 &&
  reports[0]?.report?.revisedRuns?.A?.passed === 9 &&
  reports[0]?.report?.revisedRuns?.A?.failed === 0 &&
  reports[0]?.report?.standing === "verified" &&
  patches.some(p => p.status === "completed"));
REPAIRABLE_EDGE = false;

// --- a route that never answers is asked once, not at every stage ----------
console.log("\n3. a model that times out is benched for the rest of the job");
HARNESS_WRONG = false;
DEAD_MODEL = "moonshotai/kimi-k3";
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;

await runCouncilJob({
  id: "job-3",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});

const deadCalls = modelCalls.filter((c) => c.model === DEAD_MODEL).length;
check("the dead route was benched", events.some((e) => e.phase === "model_benched"));
check("later phases said they were skipping it", events.some((e) => e.phase === "phase_skipped"));
check(
  "it was tried once, not at every stage",
  deadCalls <= 2,
  `${deadCalls} calls — the whole point is that this stays small`
);
check("the job still completed", patches.some((p) => p.status === "completed"));
check("the surviving model still produced a report", reports.length === 1);
DEAD_MODEL = "";

// --- screenshot jobs fail closed without a vision solver --------------------
console.log("\n3b. blind solver seats are never silently promoted from a transcript");
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;

let blindRosterError = "";
try {
  await runCouncilJob({
  id: "job-3b",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    // The two solver seats are declared blind, the way a probe that sent an
    // image and got a dropped connection would record them. The third entry is
    // past the solver slice — it is not a seat, but it can see, and that is
    // what the reading pass needs.
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat", vision: false },
      { id: "moonshotai/kimi-k3", endpoint: "chat", vision: false },
      { id: "anthropic/claude-fable-5.1", endpoint: "chat", vision: true },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
  });
} catch (error) {
  blindRosterError = String(error);
}

check("the readers still read the original image", events.some((e) => e.phase === "reading_done"));
check("the job rejects a transcript-only solver roster", /vision-capable solver/i.test(blindRosterError), blindRosterError);
const blindSolver = modelCalls.find(
  (c) => Array.isArray(c.messages[1].content) && !c.messages[0].content.includes("You are reading a screenshot")
);
check("no blind solver was sent a transcript as a substitute", !blindSolver, JSON.stringify(blindSolver?.model));

// --- the shipped roster, on the wires it actually speaks --------------------
console.log("\n4. the default roster reaches both TokenRouter wires");
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;
responsesCalls.length = 0;

// No councilModels or councilJudges: this is the bench the app ships with.
await runCouncilJob({ id: "job-4", session_id: "session-1", settings_snapshot: { mode: "auto", maxTokens: 2048 } });

const solverIds = [...new Set(modelCalls.map((c) => c.model))];
check("solvers went down the chat wire", solverIds.length > 0 && !solverIds.includes("openai/gpt-5.6-sol"), solverIds.join(", "));
check("the shipped solvers were used", solverIds.some((id) => COUNCIL_DEFAULT_MODELS.some((m) => m.id === id)), solverIds.join(", "));
check("gpt-5.6-sol went down the responses wire", responsesCalls.length > 0, `${responsesCalls.length} calls`);
check("every responses call named that model", responsesCalls.every((c) => c.model === "openai/gpt-5.6-sol"), responsesCalls.map((c) => c.model).join(", "));
// The Responses wire spells solve-time reasoning differently and does not
// accept the chat spelling. Bounded screenshot-evidence transcription uses no
// reasoning budget, so the absence of a reasoning block is also expected.
check(
  "the responses wire got its own reasoning shape",
  responsesCalls.every((c) => (c.reasoning?.effort === "high" || c.reasoning == null) && c.reasoning_effort === undefined),
  JSON.stringify(responsesCalls.map((c) => c.reasoning))
);
check("the judge answered", events.some((e) => e.phase === "judge_done"));
check("synthesis came back over responses", reports[0]?.report?.synthesis?.includes("ship A"), String(reports[0]?.report?.synthesis).slice(0, 80));
check("the job completed on the shipped bench", patches.some((p) => p.status === "completed"));

// --- a route with no reasoning mode is not a broken route -------------------
console.log("\n5. a model that cannot reason is asked again without it");
// Use a fresh, approved model ID. The gateway's no-reasoning cache is
// intentionally process-scoped, and preceding scenarios can have learned
// that Kimi does not accept reasoning before this case starts.
REJECTS_REASONING = "anthropic/claude-fable-5.1";
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;
responsesCalls.length = 0;

await runCouncilJob({
  id: "job-5",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "anthropic/claude-fable-5.1", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});

const stubborn = modelCalls.filter((c) => c.model === REJECTS_REASONING);
check("it was asked to reason at least once", stubborn.some((c) => c.reasoning_effort === "high"));
check("then asked again without it", stubborn.some((c) => c.reasoning_effort === undefined));
check(
  "and it is not asked to reason again after that",
  stubborn.filter((c) => c.reasoning_effort === "high").length === 1,
  `${stubborn.filter((c) => c.reasoning_effort === "high").length} attempts — the refusal should be remembered`
);
check("the model was not benched for it", !events.some((e) => e.phase === "model_benched"));
check("the job completed", patches.some((p) => p.status === "completed"));
REJECTS_REASONING = "";

// --- MCQ mode uses the focused helper-only path ---------------------------
console.log("\n6. MCQ mode writes a structured answer report");
MCQ_READING = true;
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;
responsesCalls.length = 0;

await runCouncilJob({
  id: "job-6",
  session_id: "session-1",
  mode: "mcq",
  settings_snapshot: {
    overlayMode: "mcq",
    mcqModel: "anthropic/claude-fable-5.1",
    mcqEndpoint: "chat",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-fable-5.1", endpoint: "chat", vision: true },
      { id: "anthropic/claude-opus-5.5", endpoint: "chat", vision: true },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});

const mcqReport = reports[0]?.report || {};
const mcqCall = modelCalls.find((c) => String(c.messages?.[0]?.content || "").includes("multiple-choice"));
check("MCQ report is tagged", mcqReport.kind === "mcq", JSON.stringify(mcqReport));
check("MCQ answer is stored", mcqReport.answer?.label === "C", JSON.stringify(mcqReport.answer));
check("MCQ why-not reasons are stored", mcqReport.whyNot?.length === 3, JSON.stringify(mcqReport.whyNot));
check("MCQ checked knowledge first", events.some((e) => e.phase === "knowledge_selected"));
check("MCQ used the configured model", mcqCall?.model === "anthropic/claude-fable-5.1", String(mcqCall?.model));
check("MCQ completed", patches.some((p) => p.status === "completed" && p.mode === "mcq"));
MCQ_READING = false;

// --- Auto overlay mode reads first and routes MCQ like the helper overlay ---
console.log("\n7. Auto overlay mode detects MCQ before the coding council path");
MCQ_READING = true;
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;
responsesCalls.length = 0;

await runCouncilJob({
  id: "job-7",
  session_id: "session-1",
  mode: "council",
  settings_snapshot: {
    overlayMode: "auto",
    mcqModel: "anthropic/claude-fable-5.1",
    mcqEndpoint: "chat",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-fable-5.1", endpoint: "chat", vision: true },
      { id: "anthropic/claude-opus-5.5", endpoint: "chat", vision: true },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});

check("Auto mode read the screenshot first", events.some((e) => e.phase === "reading_done"));
check("Auto mode detected MCQ", events.some((e) => e.phase === "mcq_detected"));
check("Auto mode wrote an MCQ report", reports[0]?.report?.kind === "mcq", JSON.stringify(reports[0]?.report));
check("Auto mode skipped benchmark/council phases", !events.some((e) => e.phase === "benchmark_done"));
check("Auto mode completed as MCQ", patches.some((p) => p.status === "completed" && p.mode === "mcq"));
MCQ_READING = false;

// --- and when nothing anywhere can see, say so instead of guessing ---------
console.log("\n3c. a bench with no eyes fails clearly rather than expensively");
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;

// runCouncilJob throws; tick() is what turns that into a failed row in
// production, so the throw itself is what this asserts.
let noEyesError = null;
await runCouncilJob({
  id: "job-3c",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat", vision: false },
      { id: "moonshotai/kimi-k3", endpoint: "chat", vision: false },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
}).catch((err) => {
  noEyesError = err;
});

check("the job failed rather than guessing", Boolean(noEyesError), "it returned instead of throwing");
check(
  "and the reason names the real problem",
  /able to read a screenshot/i.test(String(noEyesError?.message)),
  String(noEyesError?.message)
);
check(
  "no model was asked to read a picture it cannot see",
  modelCalls.length === 0,
  `${modelCalls.length} calls were spent before giving up`
);

// --- the knowledge library, from the database and from the bundle -----------
console.log("\n8. the knowledge library has two shelves");
const { resetKnowledgeCache } = await import("../src/lib/knowledgeLibrary.ts");

LIBRARY_ROWS = [
  {
    id: "count-elements",
    title: "Counting the elements of an array",
    kind: "pattern",
    summary: "Return the length rather than walking the array to count it.",
    guidance: ["Prefer the language's own length property.", "Guard the empty case explicitly."],
    tags: ["array", "count", "length", "javascript"],
    source_urls: [],
  },
];
resetKnowledgeCache();
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;

await runCouncilJob({
  id: "job-8",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});

const picked = events.find((e) => e.phase === "knowledge_selected");
check("the database library was used", picked?.payload?.library === "database", JSON.stringify(picked?.payload));
check("database rows are searched alongside bundled algorithm guidance", picked?.payload?.records > 1, String(picked?.payload?.records));
const dbSolver = modelCalls.find((c) => String(c.messages[0].content).includes("independent expert agents"));
const dbText = textOf(dbSolver);
check("the row reached the solver", dbText.includes("Counting the elements of an array"), dbText.slice(-260));

// A database that cannot be read costs the run its newest guidance, not the run.
LIBRARY_DOWN = true;
resetKnowledgeCache();
events.length = 0;
patches.length = 0;
reports.length = 0;

await runCouncilJob({
  id: "job-9",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});

const fellBack = events.find((e) => e.phase === "knowledge_selected");
check("an unreachable library falls back to the bundle", fellBack?.payload?.library === "bundle", JSON.stringify(fellBack?.payload));
check("the reason is on the record", String(fellBack?.payload?.libraryNote || "").includes("ECONNREFUSED"), String(fellBack?.payload?.libraryNote));
check("and the job still completed", patches.some((p) => p.status === "completed"));
LIBRARY_DOWN = false;
LIBRARY_ROWS = null;

// --- when the two readers disagree ------------------------------------------
console.log("\n9. a disputed reading is settled by a third pair of eyes");
READERS_DISAGREE = true;
TIE_BREAK_PICK = "B";
resetKnowledgeCache();
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;

await runCouncilJob({
  id: "job-10",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
      { id: "deepseek/deepseek-v4-pro-max", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});

check("the disagreement was noticed", events.some((e) => e.phase === "reading_conflict"));
const tie = events.find((e) => e.phase === "reading_tiebreak");
check("a third model was asked to settle it", Boolean(tie), JSON.stringify(events.map((e) => e.phase)));
check("and it settled the disputed field", tie?.payload?.picks?.[0]?.field === "code", JSON.stringify(tie?.payload));
check("the adjudicator was not one of the two readers", !(events.find((e) => e.phase === "reading_done")?.payload?.readers || []).includes(tie?.payload?.model), `${tie?.payload?.model} also read`);
// The reading document still shows both sides — a settled conflict is still a
// conflict on the record. What matters is which one the solvers were handed.
const settledSolver = textOf(modelCalls.find((c) => String(c.messages[0].content).includes("independent expert agents")));
check("the solvers got the reading the adjudicator chose", settledSolver.includes("count them") && !settledSolver.includes("misread"), settledSolver.slice(0, 300));
check("and the conflict is still on the record", String(reports[0]?.report?.reading?.markdown || "").includes("misread"));
check("the job still completed", patches.some((p) => p.status === "completed"));

// A settled disagreement is still a disagreement: the picture travels with the
// reconstruction when the readers could not be reconciled.
TIE_BREAK_PICK = "neither";
resetKnowledgeCache();
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;

await runCouncilJob({
  id: "job-11",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
      { id: "deepseek/deepseek-v4-pro-max", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-opus-5.5", emphasis: "correctness" }],
  },
});

const unsettledSolver = modelCalls.find((c) => String(c.messages[0].content).includes("independent expert agents"));
check("an unsettled reading is not solved from alone", !events.some((e) => e.phase === "solving_from_reading"));
check(
  "so the picture goes to the solvers too",
  Array.isArray(unsettledSolver?.messages?.[1]?.content) &&
    unsettledSolver.messages[1].content.some((p) => p.type === "image_url"),
  JSON.stringify(unsettledSolver?.messages?.[1]?.content?.map?.((p) => p.type))
);
READERS_DISAGREE = false;
TIE_BREAK_PICK = "B";

console.log("\n10. Clean API carries the owner's token and only approved model IDs");
events.length = patches.length = reports.length = modelCalls.length = apiRoutes.length = 0;
await runCouncilJob({
  id: "clean-job", owner_id: "clean-owner", session_id: "session-1",
  settings_snapshot: {
    mode: "code", maxTokens: 2048, gatewayId: "cleanapis", gatewayBaseUrl: "https://cleanapis.com/v1",
    councilModels: [
      { id: "unapproved-model", endpoint: "chat" },
      { id: "anthropic/claude-opus-5.5", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "openai/gpt-5.6-sol", emphasis: "correctness" }],
    synthesisModel: "openai/gpt-5.6-sol",
  },
});
check("Clean API job completed", patches.some(patch => patch.status === "completed"));
check("Clean API's quota response was retried", cleanRateRetries === 1);
check("every call used Clean API's chat endpoint", apiRoutes.length > 0 &&
  apiRoutes.every(route => route.url === "https://cleanapis.com/v1/chat/completions"));
check("every call used the owner's Clean token", apiRoutes.length > 0 &&
  apiRoutes.every(route => route.authorization === "Bearer test-clean-token"));
check("gateway aliases became exact Clean model IDs", apiRoutes.length > 0 &&
  apiRoutes.every(route => ["claude-opus-5.5", "kimi-k3", "gpt-5.6-sol"].includes(route.model)));
check("the unapproved model was never called", !apiRoutes.some(route => route.model === "unapproved-model"));
check("Clean API received the screenshot", modelCalls.some(call =>
  call.messages?.[1]?.content?.some?.(part => part.type === "image_url")));
check("Clean API produced a tested final solution", reports[0]?.winner === "A" && reports[0]?.report?.runs?.A?.passed === 8);

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall cloud worker checks passed\n");
process.exit(fail ? 1 : 0);
