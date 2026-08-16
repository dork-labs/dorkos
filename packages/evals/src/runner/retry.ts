/**
 * The flake policy: what counts as INFRASTRUCTURE rather than a verdict, and the
 * one retry that follows from it.
 *
 * ## THE MEASUREMENT THIS EXISTS FOR
 *
 * Ten credentialed runs of the three governance cases were measured on
 * 2026-07-25. The oracles were 8 for 8 — every oracle that executed returned the
 * correct verdict. The two runs that did not pass never reached an oracle at
 * all: the model resolved the gated tool's schema, said in its own thinking
 * trace that it would call it, and then searched for the schema again instead,
 * 29 tool calls deep, until the 90-second turn guard cut the turn off. Both runs
 * stopped at 91,776ms and 91,778ms — an attractor state, not jitter.
 *
 * So the suite has two different things wearing one label. The product mechanism
 * under test is stable. The model's path to it is not. Retrying the second while
 * gating on the first is the only reading of that data that is worth anything.
 *
 * ## THE RULE, AND WHY IT CANNOT SWALLOW A REAL FAILURE
 *
 * {@link isInfrastructureError} requires ALL THREE of:
 *
 * 1. `status === 'error'`. An oracle that returns `passed: false` scores the
 *    eval `fail`, never `error` (`runner/run-eval.ts` sets the two from
 *    different branches). So no oracle verdict can reach this predicate at all.
 * 2. `oracleResults` is EMPTY. Not "no red oracles" — none ran. The runner
 *    populates `oracleResults` in one place, and only on a turn that ended
 *    `done`. A single executed oracle, red OR green, disqualifies the run:
 *    once the product has been observed, what was observed is the answer.
 * 3. `error` is exactly {@link TURN_TIMEOUT_ERROR}. Not "any runner error". A
 *    `409 SESSION_LOCKED`, a rejected trigger, a 403 from the boundary check, a
 *    launcher fault — each is a distinct message and each stays a plain error,
 *    because any of them can be the product breaking.
 *
 * Clause 3 is the narrow one, and narrow is the point: a turn timeout is the ONE
 * signature the measurement covers. A future signature needs its own
 * measurement, not an `includes()`.
 *
 * ## WHAT THIS CLASSIFICATION DOES AND DOES NOT BUY
 *
 * It buys ONE more attempt. It does not convert a VERDICT into a pass, it does
 * not exempt anything from the run gate, and a second timeout is still an error
 * on the result. Be exact about that first clause: if attempt 1 times out and
 * attempt 2 passes, the recorded result IS a pass where an un-retried run would
 * have reported an error. That is the entire point. What can never happen is a
 * retry overriding something an oracle said, because a run that reached an
 * oracle is not eligible for a retry at all. A case that keeps timing out is not a case that keeps getting
 * forgiven — it is a case whose result is `error` twice with `retried: true`,
 * which is what a harness bug looks like. Two of those in a row means stop and
 * fix the harness rather than keep spending (`packages/evals/README.md`).
 *
 * A product regression that hangs the turn forever therefore costs one extra
 * attempt and then reports exactly what it is. That is the worst case, and it is
 * the price of not training everyone to ignore a red.
 *
 * @module evals/runner/retry
 */
import type { EvalResult } from '../types.js';

/**
 * The error message a turn that never reached a terminal frame records. Pinned
 * here, beside the predicate that matches it, because a reworded message on the
 * runner's side would otherwise silently stop the classification from ever
 * firing — the failure mode where a policy quietly becomes decoration.
 */
export const TURN_TIMEOUT_ERROR = 'Turn timed out before reaching a terminal frame.';

/**
 * Whether a result is the measured INFRASTRUCTURE signature — the turn timed out
 * before any oracle ran — rather than something the product did.
 *
 * See the module TSDoc for the three clauses and the argument that they cannot
 * swallow a real failure.
 *
 * @param result - The scored result of one attempt.
 * @returns True when the attempt never produced a verdict and should be retried.
 */
export function isInfrastructureError(result: EvalResult): boolean {
  return (
    result.status === 'error' &&
    result.oracleResults.length === 0 &&
    result.error === TURN_TIMEOUT_ERROR
  );
}

/** The transcript file name for one attempt at a case. */
export function transcriptNameForAttempt(evalId: string, attempt: number): string {
  return attempt <= 1 ? `${evalId}.jsonl` : `${evalId}.retry.jsonl`;
}

/** Options for {@link runWithInfrastructureRetry}. */
export interface InfrastructureRetryOptions {
  /**
   * Guard consulted before the second attempt. Returning false keeps the first
   * attempt's result. The suite passes its budget check here: a retry spends
   * again, and a run that has already blown its ceiling must not.
   */
  canRetry?: () => boolean;
}

/**
 * Run one eval case, and run it a SECOND time if the first attempt hit the
 * infrastructure signature.
 *
 * Returns the second attempt's result whenever a second attempt happened —
 * including when it is worse than the first. The retry buys the case another
 * chance to reach its oracles; whatever the oracles then say is the answer.
 *
 * The infrastructure signature this retries is a turn timeout — a `failed`
 * outcome — so attempt 1 retains its OWN sandbox/logs under its OWN
 * attempt-scoped name exactly like any other failure (DOR-1241, `run-eval.ts`).
 * But the RECORDED result is always attempt 2's, so without carrying attempt
 * 1's pointers forward, a double timeout (DOR-1229's hang class — the exact
 * reason retention exists) would retain attempt 1's evidence on disk with
 * nothing in `results.json` pointing at it. `priorAttempt*` on the merged
 * result is that pointer (DOR-1241 review, Important 2).
 *
 * @param attempt - Runs one attempt; receives the 1-based attempt number.
 * @param opts - See {@link InfrastructureRetryOptions}.
 * @returns The result to record for this case.
 */
export async function runWithInfrastructureRetry(
  attempt: (attemptNumber: number) => Promise<EvalResult>,
  opts: InfrastructureRetryOptions = {}
): Promise<EvalResult> {
  const first = await attempt(1);
  if (!isInfrastructureError(first)) return first;
  if (opts.canRetry && !opts.canRetry()) return first;

  const second = await attempt(2);
  return {
    ...second,
    retried: true,
    ...(first.retainedSandbox ? { priorAttemptRetainedSandbox: first.retainedSandbox } : {}),
    ...(first.retainedLogsPath ? { priorAttemptRetainedLogsPath: first.retainedLogsPath } : {}),
  };
}
