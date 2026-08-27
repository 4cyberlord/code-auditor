process.env.SUPABASE_URL = "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.TOKENROUTER_API_KEY = "tokenrouter";
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
  if (href.includes("/rest/v1/solve_jobs?id=eq.job-1")) {
    const patch = JSON.parse(init.body);
    patches.push(patch);
    return json([{ id: "job-1", session_id: "session-1", settings_snapshot: {}, ...patch }]);
  }
  if (href.includes("/rest/v1/solve_job_images?job_id=eq.job-1")) {
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
  if (href.includes("/chat/completions")) {
    const req = JSON.parse(init.body);
    modelCalls.push(req);
    const system = req.messages[0].content;
    if (system.includes("You write test harnesses for candidate solutions")) {
      return modelReply(`<<<TESTS
HARNESS: javascript
\`\`\`javascript
<<<SOLUTION>>>
let failed = 0;
const cases = [
  { name: "empty", input: [], want: 0 },
  { name: "three", input: [1, 2, 3], want: 3 },
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

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall cloud worker checks passed\n");
process.exit(fail ? 1 : 0);
