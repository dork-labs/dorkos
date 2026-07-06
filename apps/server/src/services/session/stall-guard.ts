/**
 * Inactivity watchdog for detached turns: wraps a runtime's per-turn
 * `StreamEvent` stream and, when the source goes silent past a threshold,
 * interrupts the runtime and closes the turn with a typed error so the
 * projector settles instead of pinning `streaming` forever.
 *
 * Why inactivity-based rather than absolute turn duration: long turns are
 * legitimate (a multi-hour agent run that keeps emitting tool events is
 * healthy); SILENCE is the failure signal. A stalled runtime subprocess (e.g. a
 * hung `codex exec`) stops yielding entirely, so an idle-gap clock catches
 * exactly the pathological case while never bounding honest work.
 *
 * Why check-at-expiry pause rather than pause/resume bookkeeping: the projector
 * already tracks `blocked` (a pending approval/question the operator may
 * legitimately sit on for hours) precisely, so the guard just asks `isPaused()`
 * when the timer fires and re-arms if so. No subscription plumbing, no
 * paused-duration accounting; the worst case is detection at 2x the threshold
 * after an unblock, which is acceptable for a 10-minute failsafe.
 *
 * Abandoned-source suppression: once the stall fires, the guard NEVER consumes
 * another source event; the pending `next()` is detached (rejection-silenced)
 * and `iterator.return()` is fired without awaiting (an async generator's
 * `return()` queues behind the pending `next()` and may itself hang on a truly
 * stuck source). Because nothing after the stall is ever read, a late
 * abort-induced quiet `done` from the runtime can never contradict the injected
 * error close: it is simply never observed.
 *
 * @module services/session/stall-guard
 */
import type { StreamEvent } from '@dorkos/shared/types';

/** Race sentinel: the inactivity timer expired before the next source event. */
const STALL_TIMEOUT = Symbol('stall-timeout');

/** Configuration for {@link withStallGuard}. */
export interface StallGuardOpts {
  sessionId: string;
  /** Inactivity window (ms) between source events before the turn is declared stalled. */
  timeoutMs: number;
  /** True while the stall clock must not fire (session blocked on the operator). */
  isPaused: () => boolean;
  /** Interrupt hook (runtime.interruptQuery). Resolves false when no in-flight turn was found. */
  onStall: () => Promise<boolean>;
  /** Diagnostics sink for onStall rejections (never thrown). */
  onError?: (err: unknown) => void;
}

/**
 * Forward a turn's `StreamEvent`s, racing each source `next()` against an
 * inactivity timer. On a stall (timer expiry while not paused) the source is
 * abandoned, `onStall` interrupts the runtime, and exactly three events close
 * the turn: a typed `error` (code `turn_stalled`), a `session_status` carrying
 * `terminalReason: 'error'`, and a terminal `done`, the same shapes
 * `guardTurnErrors` injects on a throw, so the durable stream and the
 * projector settle identically. The stream always ends cleanly (never throws
 * from a stall), so the caller's completion path (lock release included)
 * fires exactly as it does for a healthy turn.
 *
 * A source throw is NOT translated here: the timer is cleared and the throw
 * propagates, because the guard sits INSIDE `guardTurnErrors`, which owns
 * throw translation.
 *
 * @param source - The runtime's per-turn `StreamEvent` stream.
 * @param opts - Timeout, pause probe, interrupt hook, and diagnostics sink.
 */
export async function* withStallGuard(
  source: AsyncIterable<StreamEvent>,
  opts: StallGuardOpts
): AsyncGenerator<StreamEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  try {
    // Exactly ONE pending next() at a time. A paused expiry re-arms a fresh
    // timer against the SAME pending promise; only a delivered event advances it.
    let pending = iterator.next();
    while (true) {
      const expiry = new Promise<typeof STALL_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(STALL_TIMEOUT), opts.timeoutMs);
        // Never hold the process open for a watchdog.
        timer.unref();
      });
      let winner: IteratorResult<StreamEvent> | typeof STALL_TIMEOUT;
      try {
        // A source throw rejects the race; the finally clears the timer and the
        // throw propagates to guardTurnErrors (which owns translation).
        winner = await Promise.race([pending, expiry]);
      } finally {
        clearTimer();
      }

      if (winner !== STALL_TIMEOUT) {
        // Event won the race: forward it and re-arm against the next one.
        if (winner.done) return;
        yield winner.value;
        pending = iterator.next();
        continue;
      }

      if (opts.isPaused()) {
        // Blocked on the operator: the silence is legitimate. Loop to re-arm a
        // fresh full-threshold timer against the same pending next().
        continue;
      }

      // THE STALL. Detach from the source: silence the abandoned next() so a
      // late rejection can never become an unhandled rejection, and fire
      // return() without awaiting it (it queues behind the pending next() and
      // may itself hang on a truly stuck source).
      void pending.catch(() => {});
      void Promise.resolve(iterator.return?.()).catch(() => {});

      let details = 'No in-flight turn was found to abort; the runtime may have leaked a process.';
      try {
        if (await opts.onStall()) details = 'The in-flight turn was aborted.';
      } catch (err) {
        details = 'Interrupting the turn failed; the runtime may have leaked a process.';
        opts.onError?.(err);
      }

      yield {
        type: 'error',
        data: {
          message: `No activity from the agent for ${formatWindow(opts.timeoutMs)}, so the turn was interrupted.`,
          code: 'turn_stalled',
          category: 'execution_error',
          details,
        },
      };
      // session_status carries the terminalReason feedProjector attaches to the
      // closing turn_end; the trailing done triggers that single turn_end
      // (mirrors guardTurnErrors' terminal sequence exactly).
      yield {
        type: 'session_status',
        data: { sessionId: opts.sessionId, terminalReason: 'error' },
      };
      yield { type: 'done', data: { sessionId: opts.sessionId } };
      return;
    }
  } finally {
    clearTimer();
    // Consumer-cancellation safety: if the guard itself is return()'d or
    // throws mid-race, finalize the source too so its generator (and any
    // subprocess behind it) is not left suspended. Fire-and-forget for the
    // same reason as the stall path; a well-behaved iterator tolerates the
    // double return() after a stall.
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

/** Human form of the inactivity window: whole minutes, or seconds below one. */
function formatWindow(timeoutMs: number): string {
  if (timeoutMs >= 60_000) return `${Math.round(timeoutMs / 60_000)} minutes`;
  return `${Math.round(timeoutMs / 1000)} seconds`;
}
