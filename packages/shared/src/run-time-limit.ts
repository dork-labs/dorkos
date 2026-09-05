/**
 * What a run stopped by its own time limit says — on both dispatch paths.
 *
 * A scheduled run can be stopped by a clock on either path that carries it: the
 * direct one in `apps/server`, and the relay's in `packages/relay`. A person
 * reading run history sees a run row, not a path, so the two must say the same
 * thing. They did not: the direct path wrote this sentence while the relay path
 * wrote "Run timed out (TTL budget expired)", which sent whoever read it looking
 * for a budget setting that does not exist (DOR-1786). The sentence therefore
 * lives here, in the one package both paths can import, instead of being copied
 * into each of them and drifting again — the same reason `run-outcome` holds the
 * rule that decides whether a run FAILED.
 *
 * ## Why the duration is optional
 *
 * Only the DIRECT path holds a duration worth printing: it schedules the run
 * against the task's own `maxRuntime` and knows exactly what that was. The relay
 * path is handed an absolute deadline on the envelope and never learns the span
 * it was cut from. Reconstructing one from the envelope's timestamps would print
 * a number nobody set — the deadline is stamped a few milliseconds after the
 * limit is read, so a 5m limit formats as "4m 59s", and on a task with no limit
 * of its own it would print the relay's internal default as if a person had
 * chosen it. A wrong number is worse than no number, so that path says the same
 * sentence with the number left out.
 *
 * ## Why it takes a formatted string
 *
 * The duration formatter (`apps/server/src/lib/format-duration.ts`) is the
 * server's, and `packages/relay` cannot import from an app. Taking the already
 * formatted text keeps the formatting where the duration is and leaves the relay
 * — which has no duration to format — needing none of it.
 *
 * @module run-time-limit
 */

/**
 * How a run that the clock stopped is described on its run row.
 *
 * @param limit - The run's time limit, already formatted for a person ("5m",
 *   "1h 30m"). Omitted by a caller that knows the run ran out of time but not
 *   what its limit was; see the module note.
 * @returns The line to write on the run row.
 */
export function runTimeLimitError(limit?: string): string {
  return limit
    ? `Run stopped after passing its ${limit} time limit`
    : 'Run stopped after passing its time limit';
}
