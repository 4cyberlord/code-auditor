/**
 * Replaying the deterministic winner layer over reports that already happened.
 *
 * Kept apart from the CLI so it can be run against fixtures — a stored batch
 * JSON, or a hand-written report — without a Supabase project. The parsers are
 * the part of this change most likely to be quietly wrong on real model output,
 * and the cheapest honest test of them is every run the system has already paid
 * for.
 */

const { parseCouncilSynthesis, parseJudgeReport, decideWinner, gateFor } = await import(
  "../../src/lib/council.ts"
);

/**
 * Normalises the shapes a report can arrive in.
 *
 * Three of them exist: a `council_reports` row, a result from the batch
 * runner's JSON (which wraps the row), and the report object on its own.
 * Accepting all three is what lets the same code read the database and a file
 * on disk.
 */
export function normalizeRows(input) {
  const rows = Array.isArray(input) ? input : (input?.results ?? input?.rows ?? [input]);
  return rows
    .map((row) => {
      if (!row) return null;
      const wrapped = row.report?.report ? row.report : row;
      const report = wrapped.report?.candidates ? wrapped.report : (row.report ?? row);
      if (!report || !Array.isArray(report.candidates)) return null;
      return {
        jobId: row.job_id ?? row.jobId ?? wrapped.job_id ?? "(unknown job)",
        at: row.created_at ?? row.at ?? wrapped.created_at ?? "",
        winner: wrapped.winner ?? report.winner ?? "",
        synthesis: wrapped.synthesis ?? report.synthesis ?? "",
        report,
      };
    })
    .filter(Boolean);
}

export function replayReports(input) {
  const rows = normalizeRows(input);
  const health = {
    syntheses: 0,
    synthesesParsed: 0,
    withWinnerLine: 0,
    withApproach: 0,
    judgeReports: 0,
    judgesRanked: 0,
  };
  const results = [];

  for (const row of rows) {
    const report = row.report;
    const candidates = report.candidates ?? [];
    const runs = report.runs ?? {};
    const revisedRuns = report.revisedRuns ?? {};

    // The same rule the pipeline uses: a revised candidate is judged on its
    // revision, so that is the run the gate reads.
    const gateRuns = {};
    for (const cand of candidates) {
      const run = cand.revised ? revisedRuns[cand.letter] : runs[cand.letter];
      if (run) gateRuns[cand.letter] = run;
    }

    const parsed = parseCouncilSynthesis(row.synthesis || report.synthesis || "");
    health.syntheses += 1;
    if (parsed.wellFormed) health.synthesesParsed += 1;
    if (parsed.winner) health.withWinnerLine += 1;
    if (parsed.approach.trim()) health.withApproach += 1;

    const readings = (report.judges ?? [])
      .filter((j) => j.text)
      .map((j) => ({ model: j.model, emphasis: j.emphasis, ...parseJudgeReport(j.text) }));
    health.judgeReports += readings.length;
    health.judgesRanked += readings.filter((j) => j.ranking.length > 0).length;

    const decision = decideWinner({
      claimed: parsed.winner,
      judges: readings,
      runs: gateRuns,
      letters: candidates.map((x) => x.letter),
    });

    const stored = String(row.winner || "").trim().toUpperCase();
    const changed = decision.winner !== stored;
    results.push({
      jobId: row.jobId,
      at: row.at,
      stored,
      replayed: decision.winner,
      source: decision.source,
      changed,
      kind: !changed
        ? "same"
        : !stored && decision.winner
          ? "rescued"
          : stored && !decision.winner
            ? "withdrawn"
            : "moved",
      gates: Object.fromEntries(Object.values(gateRuns).map((r) => [r.letter, gateFor(r)])),
      tally: decision.tally.map((t) => `${t.letter}:${t.points}`).join(" "),
      why: decision.disagreement || decision.overruledReason || "",
      parsedWinner: parsed.winner,
      judgesRanked: readings.filter((j) => j.ranking.length > 0).length,
      judgesTotal: readings.length,
    });
  }

  const counts = results.reduce((acc, x) => ({ ...acc, [x.kind]: (acc[x.kind] ?? 0) + 1 }), {});
  return { results, health, counts };
}
