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
 * sentence with the number left out. (The scheduler now sends the span too, as
 * `timeLimitMs` (DOR-4576), and with it the formatted `timeLimit`; an envelope
 * without one still gets the sentence without a number.)
 *
 * ## Why it takes a formatted string
 *
 * The duration formatter (`apps/server/src/lib/format-duration.ts`) is the
 * server's, and `packages/relay` cannot import from an app. Taking the already
 * formatted text keeps the formatting where the duration is and leaves the relay
 * — which has no duration to format — needing none of it.
 *
 * ## When the limit counts
 *
 * Only from when the run's turn starts. A turn that has to wait for a free
 * agent slot says so on its stream ({@link SLOT_WAIT_STATUS}), and both paths
 * pause the limit while it does, through {@link pauseWhileWaitingToStart}. A
 * run queued behind a full computer used to spend its whole limit in line and
 * be stopped with nothing done (DOR-4576).
 *
 * @module run-time-limit
 */
import type { PausableAwakeTimeout } from './awake-clock.js';
import { SLOT_WAIT_STATUS } from './schemas.js';

/**
 * How every time-limit line opens. The fails-twice notice reads a run line back
 * into fixed words by its opening (`schedule-notice-copy.ts`, DOR-4121).
 */
export const RUN_TIME_LIMIT_OPENING = 'Run stopped after passing its';

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
    ? `${RUN_TIME_LIMIT_OPENING} ${limit} time limit`
    : `${RUN_TIME_LIMIT_OPENING} time limit`;
}

/**
 * What the turn says while it waits to start, or null when `event` is anything
 * else.
 *
 * @param event - One event from the run's stream.
 */
export function waitingToStartMessage(event: { type: string; data?: unknown }): string | null {
  if (event.type !== 'system_status') return null;
  const data = event.data as { message?: unknown; status?: unknown } | undefined;
  if (data?.status !== SLOT_WAIT_STATUS) return null;
  return typeof data.message === 'string' ? data.message : '';
}

/**
 * Watch a run's stream and pause its limit while the turn waits to start.
 *
 * A wait is the slot-wait status; any other event means the turn is running,
 * so the limit counts again. `onWaiting` hears the wait's own words when it
 * begins and `null` when it ends, so the run row can say "still waiting"
 * rather than look stuck.
 *
 * @param limit - The run's time limit, already counting.
 * @param onWaiting - Told when a wait begins (its words) and ends (`null`).
 * @returns The observer to call with every event of the run's stream.
 */
export function pauseWhileWaitingToStart(
  limit: Pick<PausableAwakeTimeout, 'pause' | 'resume'>,
  onWaiting: (message: string | null) => void
): (event: { type: string; data?: unknown }) => void {
  let waiting = false;
  return (event) => {
    const message = waitingToStartMessage(event);
    if (message !== null) {
      if (waiting) return;
      waiting = true;
      limit.pause();
      onWaiting(message);
    } else if (waiting) {
      waiting = false;
      limit.resume();
      onWaiting(null);
    }
  };
}
