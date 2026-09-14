/**
 * The acceptance checks, checked.
 *
 * `scripts/lib/acceptance.mjs` is what decides whether a real batch run passed,
 * and it is the one piece of the verification path that never runs against a
 * known-bad input in normal use: live runs are mostly healthy, so its failure
 * behaviour would otherwise be untested exactly when it matters. These feed it
 * reports that are deliberately wrong and insist it says so.
 */
import { verify } from "../scripts/lib/acceptance.mjs";

let fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const statusOf = (checks, name) => checks.find((c) => c.name === name)?.status;
const detailOf = (checks, name) => checks.find((c) => c.name === name)?.detail || "";

const run = (letter, over = {}) => ({
  letter,
  ran: true,
  ok: true,
  passed: 19,
  failed: 0,
  durationMs: 41,
  note: "",
  runtime: "node 22",
  ...over,
});

const healthy = () => ({
  label: "lc4",
  jobId: "job-1",
  elapsedMs: 600_000,
  job: { status: "completed" },
  events: [
    { phase: "problem_contract_done", level: "info" },
    { phase: "revision_done", level: "info" },
    { phase: "reverifying", level: "info" },
  ],
  report: {
    winner: "A",
    report: {
      winner: "A",
      candidates: [
        { letter: "A", model: "m-a", final: { kind: "code" }, revised: { kind: "code" } },
        { letter: "B", model: "m-b", final: { kind: "code" } },
      ],
      suites: [{ language: "javascript", harness: "<<<SOLUTION>>>" }],
      runs: { A: run("A", { ok: false, passed: 17, failed: 2 }), B: run("B") },
      revisedRuns: { A: run("A") },
      reviews: [{ reviewer: "m-a", reviews: [{ letter: "A" }, { letter: "B" }] }],
      judges: [{ model: "j-1", text: "RANKING: A, B" }],
      contract: { wellFormed: true, signature: "function solve(xs)" },
      contractAgreement: { agree: true, differences: [] },
      parsed: {
        synthesis: { wellFormed: true, winner: "A", approach: "one pass" },
        tally: [
          { letter: "A", points: 2 },
          { letter: "B", points: 1 },
        ],
        winnerSource: "synthesis",
        disagreement: "",
      },
      presentation: {
        standing: "verified",
        provenance: "Candidate A — m-a",
        evidence: [{ letter: "A" }, { letter: "B" }],
      },
      oracles: [{ letter: "A", ran: true, survived: false, description: "flipped the first < to >" }],
    },
  },
});

console.log("\n1. a healthy run passes every check");
{
  const checks = verify(healthy());
  const failed = checks.filter((c) => c.status === "fail");
  check("nothing failed", failed.length === 0, JSON.stringify(failed));
  check("the gate invariant was asserted", statusOf(checks, "no gate-passed label on a failed run") === "pass");
  // The winner revised, so its evidence is the revision's run — not round one's
  // two failures, which belong to a program nobody shipped.
  check("the revised run is what the gate check read", detailOf(checks, "no gate-passed label on a failed run").includes("gate pass"), detailOf(checks, "no gate-passed label on a failed run"));
}

console.log("\n2. a pipeline that silently stopped revising is caught");
{
  const res = healthy();
  res.events = res.events.filter((e) => e.phase !== "revision_done");
  res.report.report.revisedRuns = {};
  const checks = verify(res);
  check("the missing round is a failure", statusOf(checks, "revision round") === "fail");
  check("so is the missing re-execution", statusOf(checks, "revised field executed") === "fail");
}

console.log("\n3. nothing to revise against is a skip, not a failure");
{
  const res = healthy();
  res.events = res.events.filter((e) => e.phase !== "revision_done");
  res.report.report.reviews = [{ reviewer: "m-a", reviews: [] }];
  res.report.report.candidates = res.report.report.candidates.map((c) => {
    const copy = { ...c };
    delete copy.revised;
    return copy;
  });
  res.report.report.revisedRuns = {};
  const checks = verify(res);
  check("a council with no critiques skips", statusOf(checks, "revision round") === "skip");
  check("and so does its re-execution", statusOf(checks, "revised field executed") === "skip");
}

console.log("\n4. the invariants bite when the evidence contradicts the label");
{
  const res = healthy();
  // A winner whose run failed: the exact incident the gate exists to prevent.
  res.report.report.revisedRuns = { A: run("A", { ok: false, passed: 3, failed: 9 }) };
  const checks = verify(res);
  check("a gate-passed label on a failed run fails", statusOf(checks, "no gate-passed label on a failed run") === "fail", JSON.stringify(checks));
}
{
  const res = healthy();
  res.report.report.winner = "";
  res.report.winner = "";
  const checks = verify(res);
  check("verified standing with no winner fails", statusOf(checks, "verified standing implies a winner") === "fail");
}

console.log("\n5. a harness that passes a broken program fails the batch");
{
  const res = healthy();
  res.report.report.oracles = [{ letter: "A", ran: true, survived: true, description: "flipped the first < to >" }];
  const checks = verify(res);
  check("the oracle turns the run red", statusOf(checks, "mutation oracle") === "fail");
  check("and says why in words", detailOf(checks, "mutation oracle").includes("unproven"));
}

console.log("\n6. judges that drift from the format are not silently ignored");
{
  const res = healthy();
  res.report.report.parsed.tally = [
    { letter: "A", points: 0 },
    { letter: "B", points: 0 },
  ];
  const checks = verify(res);
  check("an uncounted bench fails", statusOf(checks, "judge rankings counted") === "fail");
  check("no judges at all is a skip instead", (() => {
    const none = healthy();
    none.report.report.judges = [];
    return statusOf(verify(none), "judge rankings counted") === "skip";
  })());
}

console.log("\n7. a job that never completed reports that and nothing else");
{
  const checks = verify({ label: "lc42", job: { status: "failed", error: "no solver answered" }, events: [], report: null });
  check("one failure, named", checks.length === 1 && checks[0].status === "fail", JSON.stringify(checks));
  check("the reason survives", checks[0].detail.includes("no solver answered"), checks[0].detail);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall acceptance checks verified\n");
process.exit(fail ? 1 : 0);
