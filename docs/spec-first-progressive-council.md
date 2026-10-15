# Council Editor — Spec-first verification and progressive language delivery

## Operational sequence

1. Once reading and problem contracting complete, select the **required language** when the problem mandates one. Otherwise, use the first configured output language (default `Python`, then `Rust`, then `C++` in the cloud).
2. If the contract contains an explicit callable signature, **begin generating an independent E2B test harness concurrently** with the model solving stage. Test expected values must be derived from the problem and independent reference implementation, never from an unverified candidate.
3. As each solver finishes, send its primary-language code to bounded E2B verification as soon as the independently validated harness is available. Reuse execution records, not duplicate E2B runs. When the interface is unknown, use the existing candidate-aware harness generation path.
4. Failed candidates receive a neutral rejected status; they are not rewritten in a costly rescue loop. Keep explicit failed/unexecuted evidence in the full report.
5. Council reviews **passing** candidates for soundness, Big O time/space, constraints and best practices. It may improve a passing candidate if a substantive defect or concern is identified, but an improved version must **pass E2B again** before promotion. Mutation-oracle checks remain enabled.
6. Judges and deterministic winner gating select the strongest **E2B-verified primary-language** solution. Publish the complete code to `council_reports` immediately—**while the job is still marked running**—so Mac and helper users can read it.
7. After primary publication, use that **exact verified source implementation** to produce the requested Rust/C++/Python ports. Each port independently uses the owner's pinned documentation server, language pack, a language-native test harness with independent reference validation, E2B execution, and harness mutation quality check. Ports that do not pass are marked failed, never presented as verified.
8. Update the same saved report as ports complete, serialized to avoid lost updates. The app polls this report without re-fetching screenshots or interrupting the primary result. Mark the job `completed` only when optional port attempts have finished.

## Provisional result while the judges are still working

After the first candidate finishes E2B with at least one passing case, zero failed
cases, and a successful run, it may appear as a **provisional** answer instead of
waiting for every other model, reviewer, and judge. This is restricted to the
problem's primary language. The cloud worker evaluates the solver's stated
Big-O bound against the contracted target when both can be conservatively
normalized to a common single-variable complexity family (for example
`O(n)` or `O(n log n)`). A missing/unparseable claim, an obviously worse
claim, an unsuccessful E2B run or a different language stays hidden until the
Council has completed its decision. This **is not** an independent complexity
proof; the UI explicitly labels it as an unreviewed claim.

A provisional candidate is **not a Council winner**, nor proof against all
hidden cases. It is surfaced with that warning so a user with an urgent
problem may inspect working code while the stronger ranking proceeds. There
is no immediate oscillation between candidates as faster/slower solvers
finish: the first passing, screened candidate is retained until the
independent Council makes its final decision.

The provisional code is inserted into the existing `council_reports` row
(while the job is still `running`). The final report PATCHes that same row,
not a second duplicate insert. Both the provisional source and the final
source appear in `solutionHistory`; a later language-port update also
preserves them. A failed provisional report write is nonfatal: Council
continues, and the normal final report insert remains available.

When judges select a different verified candidate or Council improves a
candidate and successfully reruns the new source, the panel automatically
switches to the **final selected version** and shows a GitHub-style unified
line diff. Removed provisional lines are shaded red and new final-winner lines
green; unchanged lines remain neutral. The old source remains available
under "View previous provisional version" for comparison or copying. A
bounded in-app diff algorithm avoids quadratic-memory work on very large
source files. No second model request, Git commit, or destructive source
replacement is needed.

**Status hierarchy:** `provisional` = passed generated E2B tests and a
preliminary claim screen; `final` = Council-reviewed, chosen via its
deterministic tested-code winner gate; `port verified` = separately
translated code that passed its language-native E2B suite. Complexity and
runtime claims are always qualified independently of these test statuses.

## Complexity and timing decisions

- `O(n)` is a goal **only where the problem admits linear complexity**. A problem requiring `O(n log n)`, `O(V+E)`, `O(log n)`, or otherwise must not be falsely labeled linear.
- Big O is an upper bound. A corroborated `Θ(n)` bound is stronger evidence of tight growth than merely claiming `O(n)`, but a model claim alone is not a proof.
- The Council's independent audits and symbolic complexity comparator remain part of winner evaluation.
- E2B runtime includes language-specific compiler/runtime/environment effects and input-dependent noise. **Do not claim a global fastest Python/Rust/C++ port from one cross-language wall-clock reading.** Show independent measured evidence; use repeatable equivalent workloads and controlled environments before cross-language timing comparisons.
- Correctness precedes performance. No runtime advantage permits a failing port or candidate to become the selected answer.

## Guardrails

The source problem's explicitly required language outranks user preferences. No production database schema, Cloudflare setting, model gateway credential, E2B isolation contract, or live worker deployment is changed here. A saved verified primary answer remains readable even when optional porting is still working or a port fails. Target ports may legitimately fail when the problem's callable contract cannot be represented correctly by another language.

## Validation

The helper unit regression suite is `node tests/specFirstDelivery.test.mjs`, integrated into `npm test`. TypeScript and lint checks must pass. A full E2B integration test with a known problem, actual credentials, and sandbox executions is required before making production performance or correctness claims.
