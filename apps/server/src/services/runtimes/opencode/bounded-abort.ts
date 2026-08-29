/**
 * Bounded waits for an OpenCode sidecar that may never answer.
 *
 * Mirrors the load-bearing details of claude-code's `sessions/bounded-control.ts`
 * (DOR-1244) for the same reason: a promise that only a backend ack settles must
 * not be trusted to settle at all. A wedged sidecar drops the request rather
 * than refusing it, so an unbounded await hangs the caller for ever.
 *
 * Lifted off `opencode-runtime.ts` so that file stays under the repo's 500-line
 * ceiling. Nothing here touches the runtime's state — these are pure timing
 * helpers over a caller-supplied request.
 *
 * @module services/runtimes/opencode/bounded-abort
 */
import { INTERRUPT_ACK_TIMEOUT_MS } from './runtime-constants.js';

/** Sleep helper for the stream-liveness race. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What one bounded abort request concluded — mirrors claude-code's `StopAck` (`bounded-control.ts`). */
export type AbortAck =
  /** The backend answered, and the answer is `request`'s return value. */
  | { kind: 'settled'; aborted: boolean }
  /** The backend answered with a rejection — a refusal, not silence. */
  | { kind: 'refused' }
  /** Nothing answered inside the bound — which says nothing about whether it ever will. */
  | { kind: 'unacked' };

/**
 * Race one `session.abort` call against {@link INTERRUPT_ACK_TIMEOUT_MS},
 * mirroring the load-bearing details of claude-code's `awaitStopAck`
 * (`sessions/bounded-control.ts`, DOR-1244) for the same reason: a promise
 * that only a backend ack settles must not be trusted to settle at all.
 *
 * Never throws, whichever way the race goes and however `request` fails —
 * `request` is INVOKED here rather than passed in as an already-started
 * promise, so a SYNCHRONOUS throw from it becomes a `refused` like any other
 * failure instead of escaping past the bound this function exists to
 * provide — and never leaves a live timer behind.
 *
 * @param request - Makes the abort call and reports whether it actually aborted.
 * @returns The tri-state outcome; the caller decides what each means for its
 *   own `false` vs `true`.
 */
export function awaitAbortAck(request: () => Promise<boolean>): Promise<AbortAck> {
  const settled: Promise<AbortAck> = (async () => request())().then(
    (aborted) => ({ kind: 'settled', aborted }) as const,
    () => ({ kind: 'refused' }) as const
  );
  let timer: NodeJS.Timeout | undefined;
  return (async () => {
    try {
      const expiry = new Promise<AbortAck>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'unacked' }), INTERRUPT_ACK_TIMEOUT_MS);
        timer.unref?.();
      });
      return await Promise.race([settled, expiry]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
}
