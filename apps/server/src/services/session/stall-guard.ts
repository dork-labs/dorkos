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
 * Why check-at-expiry pause rather than pause/resume bookkeeping: the caller
 * can already answer "is this turn parked on a person?" precisely, so the guard
 * just asks `isPaused()` when the timer fires and re-arms if so. No
 * subscription plumbing, no paused-duration accounting; the worst case is
 * detection one full threshold after an unblock, which is acceptable for a
 * 10-minute failsafe. What that probe reads matters (DOR-782): it is the
 * projector's live pending-interaction set, NOT its `blocked` lifecycle, which a
 * concurrent turn's `turn_start` overwrites with `streaming` — that once
 * un-paused the guard for a turn still holding an unanswered approval. The set
 * carries its own expiry, so a stranded interaction cannot pause the guard
 * forever either.
 *
 * Abandoned-source suppression: once the stall fires, the guard NEVER consumes
 * another source event; the pending `next()` is detached (rejection-silenced)
 * and `iterator.return()` is fired without awaiting (an async generator's
 * `return()` queues behind the pending `next()` and may itself hang on a truly
 * stuck source). Because nothing after the stall is ever read, a late
 * abort-induced quiet `done` from the runtime can never contradict the injected
 * error close: it is simply never observed.
 *
 * Bounded interrupt (DOR-782): the interrupt itself is raced against
 * `SESSIONS.STALL_INTERRUPT_TIMEOUT_MS`. `interruptQuery` reaches the same
 * possibly-wedged subprocess the watchdog is firing about, so an unbounded await
 * on it can hold the turn in exactly the frozen state the watchdog exists to
 * end. Past the bound the turn closes anyway and says so in the error details.
 * Every stall is logged — the firing, and its outcome either way.
 *
 * @module services/session/stall-guard
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

/** Race sentinel: the inactivity timer expired before the next source event. */
const STALL_TIMEOUT = Symbol('stall-timeout');

/** Race sentinel: the interrupt did not settle inside its own bound. */
const INTERRUPT_TIMEOUT = Symbol('stall-interrupt-timeout');

/** Configuration for {@link withStallGuard}. */
export interface StallGuardOpts {
  sessionId: string;
  /** Inactivity window (ms) between source events before the turn is declared stalled. */
  timeoutMs: number;
  /**
   * True while the stall clock must not fire — the turn is legitimately waiting
   * on a person (a pending approval, question, or elicitation), not hung.
   */
  isPaused: () => boolean;
  /** Interrupt hook (runtime.interruptQuery). Resolves false when no in-flight turn was found. */
  onStall: () => Promise<boolean>;
  /**
   * How long to wait for {@link StallGuardOpts.onStall} before closing the turn
   * anyway. Defaults to {@link SESSIONS.STALL_INTERRUPT_TIMEOUT_MS}.
   */
  interruptTimeoutMs?: number;
  /** Diagnostics sink for onStall rejections (never thrown). */
  onError?: (err: unknown) => void;
}

/** What the bounded interrupt attempt concluded, and how to say it to a person. */
interface InterruptOutcome {
  /** True only when the runtime confirmed it aborted an in-flight turn. */
  interrupted: boolean;
  /** Wall time the interrupt attempt took, bounded by `interruptTimeoutMs`. */
  elapsedMs: number;
  /** The `details` string carried on the injected `turn_stalled` error. */
  details: string;
}

/**
 * Interrupt the runtime, bounded so a wedged `interruptQuery` cannot hold the
 * turn open forever — the call meant to unstick a hung subprocess reaches that
 * same subprocess, so it can hang too. Never throws: a rejection is reported
 * through `onError` and becomes an outcome like any other.
 *
 * A rejection arriving AFTER the bound already won is silenced separately, so a
 * dying transport cannot surface as an unhandled rejection.
 */
async function attemptInterrupt(opts: StallGuardOpts): Promise<InterruptOutcome> {
  const startedAt = Date.now();
  // Wrapped so a synchronous throw from onStall becomes a rejection like any
  // other, and so the extra catch below can silence a LATE rejection.
  const interrupt = (async () => opts.onStall())();
  interrupt.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    const expiry = new Promise<typeof INTERRUPT_TIMEOUT>((resolve) => {
      timer = setTimeout(
        () => resolve(INTERRUPT_TIMEOUT),
        opts.interruptTimeoutMs ?? SESSIONS.STALL_INTERRUPT_TIMEOUT_MS
      );
      timer.unref();
    });
    const winner = await Promise.race([interrupt, expiry]);
    const elapsedMs = Date.now() - startedAt;
    if (winner === INTERRUPT_TIMEOUT) {
      return {
        interrupted: false,
        elapsedMs,
        details:
          'Interrupting the turn did not finish in time; the runtime may have leaked a process.',
      };
    }
    return winner
      ? { interrupted: true, elapsedMs, details: 'The in-flight turn was aborted.' }
      : {
          interrupted: false,
          elapsedMs,
          details: 'No in-flight turn was found to abort; the runtime may have leaked a process.',
        };
  } catch (err) {
    opts.onError?.(err);
    return {
      interrupted: false,
      elapsedMs: Date.now() - startedAt,
      details: 'Interrupting the turn failed; the runtime may have leaked a process.',
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  // Only for the stall log's `inactivityMs`; the firing decision stays the
  // timer's, so a paused re-arm is unaffected by what this records.
  let lastActivityAt = Date.now();
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
        lastActivityAt = Date.now();
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

      // The measured silence, not a restatement of the threshold: a turn that
      // was paused on an operator prompt for an hour and THEN went dark reports
      // the hour, so a log reader can tell the two shapes apart.
      logger.warn('[stall-guard] no activity from the runtime; interrupting the turn', {
        sessionId: opts.sessionId,
        inactivityMs: Date.now() - lastActivityAt,
        timeoutMs: opts.timeoutMs,
      });
      const outcome = await attemptInterrupt(opts);
      const outcomeContext = {
        sessionId: opts.sessionId,
        interrupted: outcome.interrupted,
        elapsedMs: outcome.elapsedMs,
        details: outcome.details,
      };
      if (outcome.interrupted) {
        logger.info('[stall-guard] stalled turn interrupted', outcomeContext);
      } else {
        logger.warn('[stall-guard] stalled turn could not be interrupted', outcomeContext);
      }

      yield {
        type: 'error',
        data: {
          message: `No activity from the agent for ${formatWindow(opts.timeoutMs)}, so the turn was interrupted.`,
          code: 'turn_stalled',
          category: 'execution_error',
          details: outcome.details,
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
