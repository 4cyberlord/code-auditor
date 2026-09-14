/**
 * The replay, checked against reports whose right answer is known.
 *
 * `scripts/lib/replay.mjs` is what tells you whether the deterministic winner
 * layer is inert, sensible or too aggressive on historical runs — so it had
 * better read those runs correctly. These fixtures are the three outcomes that
 * decision can have, plus the shapes a stored report actually arrives in.
 */
import { replayReports, normalizeRows } from "../scripts/lib/replay.mjs";

let fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const pass = (letter) => ({ letter, ran: true, ok: true, passed: 9, failed: 0 });
const failed = (letter) => ({ letter, ran: true, ok: false, passed: 2, failed: 7 });

const batchJson = {
  results: [
    {
      jobId: "job-moved",
      report: {
        winner: "A",
        synthesis: "VERDICT: ok\nWINNER: A\nREJECTED: B - slower\nAPPROACH: one pass\nFINAL ANSWER: ship A",
        report: {
          winner: "A",
          candidates: [{ letter: "A", model: "m-a" }, { letter: "B", model: "m-b" }],
          runs: { A: pass("A"), B: pass("B") },
          revisedRuns: {},
          judges: [
            { model: "j1", emphasis: "correctness", text: "RANKING: B, A\nCORRECT: B" },
            { model: "j2", emphasis: "performance", text: "RANKING: B, A" },
          ],
        },
      },
    },
    {
      jobId: "job-rescued",
      report: {
        winner: null,
        synthesis: "VERDICT: nothing survived\nWINNER: NONE\nFINAL ANSWER: none",
        report: {
          winner: "",
          candidates: [{ letter: "A", model: "m-a" }, { letter: "B", model: "m-b" }],
          runs: { A: failed("A"), B: pass("B") },
          revisedRuns: {},
          judges: [{ model: "j1", emphasis: "correctness", text: "RANKING: B, A" }],
        },
      },
    },
    {
      jobId: "job-same",
      report: {
        winner: "A",
        synthesis: "WINNER: A\nAPPROACH: hash map\nFINAL ANSWER: ship A",
        report: {
          winner: "A",
          candidates: [{ letter: "A", model: "m-a" }],
          runs: { A: pass("A") },
          revisedRuns: {},
          judges: [{ model: "j1", emphasis: "correctness", text: "no labels anywhere in this reply" }],
        },
      },
    },
  ],
};

console.log("\n1. the three outcomes are told apart");
{
  const { results, counts } = replayReports(batchJson);
  check("every report was read", results.length === 3, String(results.length));
  check("a disagreement moves the winner", counts.moved === 1, JSON.stringify(counts));
  check("a gate-passing candidate is rescued from a NONE", counts.rescued === 1, JSON.stringify(counts));
  check("an uncontested run is left alone", counts.same === 1, JSON.stringify(counts));
  const moved = results.find((x) => x.jobId === "job-moved");
  check("and the move is explained", moved.replayed === "B" && moved.why.includes("judges ranked"), moved.why);
  const rescued = results.find((x) => x.jobId === "job-rescued");
  check("the rescue never takes a failed candidate", rescued.replayed === "B" && rescued.gates.A === "fail", JSON.stringify(rescued.gates));
}

console.log("\n2. parse health is measured, not assumed");
{
  const { health } = replayReports(batchJson);
  check("every synthesis parsed", health.synthesesParsed === 3, JSON.stringify(health));
  check("the NONE is not counted as a winner line", health.withWinnerLine === 2, JSON.stringify(health));
  // The point of the number: one judge wrote prose with no RANKING at all, and
  // that is exactly the case that leaves the tally empty in production.
  check("an unrankable judge is counted as such", health.judgesRanked === 3 && health.judgeReports === 4, JSON.stringify(health));
}

console.log("\n3. a revised candidate is replayed on its revision");
{
  const { results } = replayReports([
    {
      job_id: "job-revised",
      winner: "A",
      synthesis: "WINNER: A\nFINAL ANSWER: ship A",
      report: {
        candidates: [{ letter: "A", model: "m-a", revised: { kind: "code" } }],
        runs: { A: failed("A") },
        revisedRuns: { A: pass("A") },
        judges: [],
      },
    },
  ]);
  check("round one's failure is not held against it", results[0].gates.A === "pass", JSON.stringify(results[0].gates));
  check("and the winner stands", results[0].replayed === "A", results[0].replayed);
}

console.log("\n4. the shapes a report arrives in are all read");
{
  const row = { job_id: "j", winner: "A", synthesis: "WINNER: A", report: { candidates: [{ letter: "A" }], runs: {}, judges: [] } };
  check("a council_reports row", normalizeRows([row]).length === 1);
  check("a batch result", normalizeRows(batchJson).length === 3);
  check("anything without a field is ignored rather than crashing", normalizeRows([null, {}, { report: {} }]).length === 0);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall replay checks passed\n");
process.exit(fail ? 1 : 0);
