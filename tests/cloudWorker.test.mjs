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

const events = [];
const patches = [];
const reports = [];
const modelCalls = [];
// Flipped for the second scenario, so the generated harness rejects every
// candidate the way a harness with a wrong expectation does.
let HARNESS_WRONG = false;
// Scenario 3: one route answers nothing, ever, the way a dead endpoint does.
let DEAD_MODEL = "";
// Scenario 5: a route with no reasoning mode, which must not read as a dead seat.
let REJECTS_REASONING = "";
const responsesCalls = [];
const abort = () => Object.assign(new Error("aborted"), { name: "AbortError" });

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { "content-type": "application/json" },
  });
}

function modelReply(body) {
  return json({ choices: [{ message: { content: body } }] });
}

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
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
    if (DEAD_MODEL && req.model === DEAD_MODEL) throw abort();
    if (REJECTS_REASONING && req.model === REJECTS_REASONING && req.reasoning_effort) {
      return json({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }, { status: 400 });
    }
    const system = req.messages[0].content;
    if (system.includes("You are reading a screenshot and turning it into structured data")) {
      return modelReply(
        JSON.stringify({
          kind: "code",
          language: "javascript",
          framework: "",
          fileName: "solve.js",
          filePath: "",
          code: "export function solve(xs) { /* count them */ }",
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
    if (system.includes("You write test harnesses for candidate solutions")) {
      return modelReply(`<<<TESTS
HARNESS: javascript
\`\`\`javascript
<<<SOLUTION>>>
let failed = 0;
const cases = [
  { name: "empty", input: [], want: ${HARNESS_WRONG ? 99 : 0} },
  { name: "three", input: [1, 2, 3], want: ${HARNESS_WRONG ? 99 : 3} },
];
for (const c of cases) {
  const got = solve(c.input);
  if (got === c.want) console.log("PASS " + c.name);
  else { console.log("FAIL " + c.name + " got=" + got + " want=" + c.want); failed++; }
}
if (failed) process.exit(1);
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

const { runCouncilJob } = await import("../scripts/cloud-worker.mjs");
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
      { id: "anthropic/claude-sonnet-4.6", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-sonnet-4.6", emphasis: "correctness" }],
  },
});

check("patched completed", patches.some((p) => p.status === "completed"));
check("wrote one report", reports.length === 1);
check("report has winner", reports[0]?.winner === "A", String(reports[0]?.winner));
check("report has reviews", reports[0]?.report?.reviews?.length === 2, String(reports[0]?.report?.reviews?.length));
check("report has judges", reports[0]?.report?.judges?.length === 1, String(reports[0]?.report?.judges?.length));
check("report has benchmark suite", reports[0]?.report?.suites?.length === 1, String(reports[0]?.report?.suites?.length));
check("report has passing local runs", reports[0]?.report?.runs?.A?.passed === 2 && reports[0]?.report?.runs?.B?.passed === 2, JSON.stringify(reports[0]?.report?.runs));
check("downloaded image for model calls", modelCalls.some((c) => c.messages[1].content.some((p) => p.type === "image_url")));
check("benchmark phase event recorded", events.some((e) => e.phase === "benchmark_done"));
check("review phase event recorded", events.some((e) => e.phase === "review_done"));
check("judge phase event recorded", events.some((e) => e.phase === "judge_done"));
check("completion event recorded", events.some((e) => e.phase === "completed"));

// --- the picture becomes text, and the text selects the knowledge -----------
const solverCall = modelCalls.find(
  (c) =>
    Array.isArray(c.messages[1].content) &&
    c.messages[1].content.some((p) => p.type === "image_url") &&
    !c.messages[0].content.includes("You are reading a screenshot")
);
const solverText = solverCall?.messages[1].content.find((p) => p.type === "text")?.text || "";

// The default is now: the models that can see solve from the picture. Nothing
// is transcribed, and no model is handed a lossy copy to guess from.
check("nothing was transcribed", !events.some((e) => e.phase === "reading_done"));
check("the solver was shown the picture itself", Boolean(solverCall));
check("no transcription reached the solver", !solverText.includes("READING OF THE SCREENSHOT"), solverText.slice(0, 120));
check("the house rules reached the solver", solverText.includes("HOUSE RULES") && solverText.includes("C++"));
check("the memory target is readable", solverText.includes("20 MB"), solverText.slice(0, 400));

// Every seat is asked to think before it answers, without any phase having to
// remember to ask.
check("the solver was asked to reason", solverCall?.reasoning_effort === "high", String(solverCall?.reasoning_effort));
check("so was the reviewer", modelCalls.every((c) => c.reasoning_effort === "high"), JSON.stringify(modelCalls.map((c) => c.reasoning_effort)));

// The library arrives once the panel has produced words — which is also when
// the system can tell this was a coding problem.
check("it was recognised as a coding problem", events.some((e) => e.phase === "problem_kind" && e.payload?.coding === true));
check("knowledge was selected after solving", events.some((e) => e.phase === "knowledge_selected"));
const reviewCall = modelCalls.find((c) => c.messages[0].content.includes("senior engineer on a review council"));
const textOf = (call) =>
  (Array.isArray(call?.messages?.[1]?.content)
    ? call.messages[1].content.find((p) => p.type === "text")?.text
    : call?.messages?.[1]?.content) || "";
check(
  "the knowledge reached the reviewers",
  textOf(reviewCall).includes("Local Knowledge/RAG"),
  textOf(reviewCall).slice(0, 200)
);

// --- the gate, and the harness that convicts everybody ----------------------
console.log("\n2. a synthesis cannot promote a candidate the runner rejected");
HARNESS_WRONG = true;
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;

await runCouncilJob({
  id: "job-2",
  session_id: "session-1",
  settings_snapshot: {
    mode: "auto",
    maxTokens: 2048,
    gatewayBaseUrl: "https://api.tokenrouter.com/v1",
    councilModels: [
      { id: "anthropic/claude-sonnet-4.6", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-sonnet-4.6", emphasis: "correctness" }],
  },
});

const runs2 = reports[0]?.report?.runs || {};
check("both candidates were rejected by the harness", runs2.A?.failed > 0 && runs2.B?.failed > 0, JSON.stringify(runs2));
check("the synthesis still named A", reports[0]?.report?.synthesisClaimedWinner === "A", String(reports[0]?.report?.synthesisClaimedWinner));
check("but no winner was recorded", !reports[0]?.winner, JSON.stringify(reports[0]?.winner));
check("and the overrule was logged", events.some((e) => e.phase === "gate_overrule"));
check(
  "identical failures accuse the harness, not the code",
  events.some((e) => e.phase === "harness_suspect"),
  JSON.stringify(events.map((e) => e.phase))
);
check("the job still completed rather than dying", patches.some((p) => p.status === "completed"));

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
      { id: "anthropic/claude-sonnet-4.6", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-sonnet-4.6", emphasis: "correctness" }],
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

// --- a bench that cannot see falls back rather than failing ----------------
console.log("\n3b. blind solver seats borrow a reader from further down the roster");
events.length = 0;
patches.length = 0;
reports.length = 0;
modelCalls.length = 0;

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
      { id: "anthropic/claude-sonnet-4.6", endpoint: "chat", vision: false },
      { id: "moonshotai/kimi-k3", endpoint: "chat", vision: false },
      { id: "anthropic/claude-opus-4.6", endpoint: "chat", vision: true },
    ],
    councilJudges: [{ model: "anthropic/claude-sonnet-4.6", emphasis: "correctness" }],
  },
});

check("it said no seat could see", events.some((e) => e.phase === "no_seeing_models"));
check("so it transcribed instead", events.some((e) => e.phase === "reading_done"));
// The whole point: the reader must be a model that can actually be shown the
// picture, not one of the blind seats the fallback exists because of.
const readerEvent = events.find((e) => e.phase === "no_seeing_models");
check(
  "the reader was a model that can see",
  readerEvent?.payload?.readers?.includes("anthropic/claude-opus-4.6") &&
    !readerEvent?.payload?.readers?.includes("moonshotai/kimi-k3"),
  JSON.stringify(readerEvent?.payload?.readers)
);
const blindSolver = modelCalls.find(
  (c) => Array.isArray(c.messages[1].content) && !c.messages[0].content.includes("You are reading a screenshot")
);
const blindText = blindSolver?.messages[1].content.find((p) => p.type === "text")?.text || "";
check("the solvers got the reading", blindText.includes("READING OF THE SCREENSHOT"), blindText.slice(0, 120));
check("and were not sent an image they cannot read", !blindSolver?.messages[1].content.some((p) => p.type === "image_url"));
check("the job still completed", patches.some((p) => p.status === "completed"));

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
// The Responses wire spells reasoning differently and does not accept the
// chat spelling, so this is not the same assertion twice.
check(
  "the responses wire got its own reasoning shape",
  responsesCalls.every((c) => c.reasoning?.effort === "high" && c.reasoning_effort === undefined),
  JSON.stringify(responsesCalls.map((c) => c.reasoning))
);
check("the judge answered", events.some((e) => e.phase === "judge_done"));
check("synthesis came back over responses", reports[0]?.report?.synthesis?.includes("ship A"), String(reports[0]?.report?.synthesis).slice(0, 80));
check("the job completed on the shipped bench", patches.some((p) => p.status === "completed"));

// --- a route with no reasoning mode is not a broken route -------------------
console.log("\n5. a model that cannot reason is asked again without it");
REJECTS_REASONING = "moonshotai/kimi-k3";
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
      { id: "anthropic/claude-sonnet-4.6", endpoint: "chat" },
      { id: "moonshotai/kimi-k3", endpoint: "chat" },
    ],
    councilJudges: [{ model: "anthropic/claude-sonnet-4.6", emphasis: "correctness" }],
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
      { id: "anthropic/claude-sonnet-4.6", endpoint: "chat", vision: false },
      { id: "moonshotai/kimi-k3", endpoint: "chat", vision: false },
    ],
    councilJudges: [{ model: "anthropic/claude-sonnet-4.6", emphasis: "correctness" }],
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

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall cloud worker checks passed\n");
process.exit(fail ? 1 : 0);
