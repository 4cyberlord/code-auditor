/**
 * The acceptance checks a real Council run has to pass.
 *
 * Separated from the batch runner so they can be exercised against synthetic
 * reports by `tests/acceptance.test.mjs` without a Supabase project, a
 * TokenRouter key or an hour of wall clock. A check that has only ever been run
 * against live data is a check nobody knows the failure behaviour of.
 */

// ------------------------------------------------------- acceptance checks

/**
 * Did each mechanism actually fire?
 *
 * A batch that says "completed" tells you the pipeline did not crash. It does
 * not tell you the revision round ran, or that the contract reached anybody, or
 * that the winner was gated rather than merely named — and those are the things
 * a change to this pipeline is supposed to buy. Each check below can come back
 * red, which is the only property that makes a check worth having.
 *
 * Three outcomes, deliberately distinct. `skip` is not a failure: a run with no
 * runnable code has nothing to re-execute, and a council whose reviews all
 * arrived malformed has nothing to revise against. Calling either of those a
 * failure would train you to ignore the column.
 */
const PASS = "pass";
const FAIL = "fail";
const SKIP = "skip";

/** The gate, recomputed here rather than trusted from the report that claims it. */
const gateOf = (run) => {
  if (!run || !run.ran) return "untested";
  if (run.failed > 0 || !run.ok) return "fail";
  if (run.passed === 0) return "untested";
  return "pass";
};

export function verify(res) {
  const out = [];
  const add = (name, status, detail = "") => out.push({ name, status, detail });
  if (res.error || res.job?.status !== "completed") {
    add("job completed", FAIL, res.error || res.job?.error || res.job?.status || "unknown");
    return out;
  }
  add("job completed", PASS, `${(res.elapsedMs / 1000).toFixed(1)}s`);

  const report = res.report?.report ?? {};
  const events = res.events ?? [];
  const phase = (name) => events.some((e) => e.phase === name);
  const candidates = report.candidates ?? [];
  const runs = report.runs ?? {};
  const revisedRuns = report.revisedRuns ?? {};
  const parsed = report.parsed ?? null;
  const presentation = report.presentation ?? null;
  const executed = Object.values(runs).some((r) => r?.ran);

  // 1. the contract, read before anybody answered
  if (phase("problem_contract_done")) {
    const disputes = report.contractAgreement?.differences ?? [];
    add(
      "problem contract",
      PASS,
      disputes.length ? `readers disagreed: ${disputes[0].slice(0, 120)}` : "readers agreed"
    );
    add(
      "contract is on the report",
      report.contract?.wellFormed ? PASS : FAIL,
      report.contract?.signature || report.contract?.kind || ""
    );
  } else if (phase("problem_contract_none") || phase("problem_contract_failed")) {
    add("problem contract", FAIL, "no reader produced a usable contract");
  } else {
    add("problem contract", SKIP, "the contract pass did not run");
  }

  // 2. the revision round, which is the whole parity fix
  const critiques = (report.reviews ?? []).some((set) => (set.reviews ?? []).length > 0);
  if (!critiques) {
    add("revision round", SKIP, "no review parsed into critiques, so there was nothing to revise against");
  } else {
    add("revision round", phase("revision_done") ? PASS : FAIL, `${candidates.filter((c) => c.revised).length} revised`);
  }
  const revisedCount = Object.keys(revisedRuns).length;
  if (!(report.suites ?? []).length) {
    add("revised field executed", SKIP, "no harness was generated for this problem");
  } else if (!candidates.some((c) => c.revised)) {
    add("revised field executed", SKIP, "nothing was revised");
  } else {
    add("revised field executed", revisedCount > 0 ? PASS : FAIL, `${revisedCount} run(s)`);
  }

  // 3. the dossier: fields rather than prose
  add(
    "synthesis parsed",
    parsed?.synthesis?.wellFormed ? PASS : FAIL,
    parsed?.synthesis ? `winner ${parsed.synthesis.winner || "NONE"}, approach ${parsed.synthesis.approach ? "read" : "missing"}` : "no parsed block on the report"
  );
  const judgesCollected = (report.judges ?? []).filter((j) => j.text).length;
  if (!judgesCollected) {
    add("judge rankings counted", SKIP, "no judge answered");
  } else {
    const ranked = (parsed?.tally ?? []).some((row) => row.points > 0);
    add(
      "judge rankings counted",
      ranked ? PASS : FAIL,
      ranked ? (parsed.tally ?? []).map((t) => `${t.letter}:${t.points}`).join(" ") : "judges drifted from the RANKING format"
    );
  }
  add(
    "winner authority",
    report.winner && parsed?.winnerSource === "none" ? FAIL : PASS,
    `${report.winner || "none"} from ${parsed?.winnerSource ?? "?"}${parsed?.disagreement ? " — judges disagreed with the synthesis" : ""}`
  );

  // 4. the presentation the overlay renders
  if (!presentation) {
    add("presentation", FAIL, "no presentation on the report");
  } else {
    add(
      "presentation",
      presentation.evidence?.length === candidates.length && presentation.standing ? PASS : FAIL,
      `${presentation.standing} · ${presentation.evidence?.length ?? 0}/${candidates.length} evidence rows · ${presentation.provenance || "no provenance"}`
    );
  }

  // 5. the oracle's opinion of the harness
  const oracles = report.oracles ?? [];
  if (!oracles.length) {
    add("mutation oracle", SKIP, "no passing candidate to break");
  } else {
    add(
      "mutation oracle",
      oracles.some((o) => o.survived) ? FAIL : PASS,
      oracles.some((o) => o.survived)
        ? "the harness passed a deliberately broken program — every PASS in this run is unproven"
        : `harness caught the break (${oracles[0].description})`
    );
  }

  // 6. the invariants. These are not "did it run" — they are the two claims the
  //    product makes about every answer it ships, checked against the evidence
  //    rather than against the sentence that asserts them.
  const winnerGate = report.winner
    ? gateOf(candidates.find((c) => c.letter === report.winner)?.revised ? revisedRuns[report.winner] : runs[report.winner])
    : "";
  add(
    "no gate-passed label on a failed run",
    !report.winner || !executed || winnerGate === "pass" ? PASS : FAIL,
    report.winner ? `winner ${report.winner} gate ${winnerGate || "n/a"}` : "no winner recorded"
  );
  add(
    "verified standing implies a winner",
    presentation?.standing !== "verified" || Boolean(report.winner) ? PASS : FAIL,
    presentation?.standing ?? "no standing"
  );
  return out;
}
