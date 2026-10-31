/**
 * Proof of life for an OpenCode turn that is waiting on its model (FB-68).
 *
 * OpenCode reports nothing between accepting a prompt and the model's first
 * token: `session.status{busy}` and the in-flight `message.updated` both map to
 * no StreamEvent. A hosted model gets there in seconds. A local one (Ollama)
 * can take many minutes to load and read a long prompt, and the stall guard
 * (`services/session/stall-guard.ts`) read that silence as a launch that never
 * started and ended the turn at 2 minutes, every time.
 *
 * This wrapper sends a bare `session_status` (a sessionId and nothing else)
 * every {@link MODEL_WAIT_LIVENESS_INTERVAL_MS} while the turn is quiet with no
 * tool call open. The stall guard counts it as activity, and the normalizer
 * drops it (`toStatusChange` returns null for an empty status), so nothing is
 * stored or shown.
 *
 * What still bounds the turn:
 * - **A tool call that hangs.** While one is open the wrapper says nothing, so
 *   the ordinary inactivity window applies to tools exactly as it does on every
 *   other runtime.
 * - **A sidecar that dies.** Its event stream drops, the queue fails, and the
 *   turn ends with that error, signal or no signal.
 * - **A model that never answers.** OpenCode's own provider request timeout
 *   ends the request and reports it as a `session.error`.
 * - **The person.** Stop works the same as on any turn.
 *
 * The wrapper only asks for the next source event after the consumer has
 * resumed it. The runtime drains per-event state off the shared context
 * (`captureOpenCodeMedia`) between events, so reading ahead would reorder it.
 * A consumer that stops while a source read is still waiting (it stopped on a
 * signal) gets the source closed without waiting: an async generator's
 * `return()` queues behind its pending `next()`, which only the next wire
 * event would settle.
 *
 * @module services/runtimes/opencode/events/model-wait-liveness
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { MODEL_WAIT_LIVENESS_INTERVAL_MS } from '../runtime-constants.js';
import type { OpenCodePartState } from './part-event-mapper.js';
import {
  mapOpenCodeTurn,
  type OpenCodeEventContext,
  type OpenCodeWireEvent,
} from './event-mapper.js';

/** Race sentinel: the interval passed with no source event. */
const TICK = Symbol('model-wait-tick');

/** The context fields the wrapper reads: the turn's id and its tool calls. */
export type ModelWaitContext = Pick<
  OpenCodePartState,
  'startedToolCallIds' | 'endedToolCallIds'
> & {
  readonly sessionId: string;
};

/** Whether a tool call has started and not yet ended. */
function hasOpenToolCall(ctx: ModelWaitContext): boolean {
  for (const id of ctx.startedToolCallIds) {
    if (!ctx.endedToolCallIds.has(id)) return true;
  }
  return false;
}

/**
 * Pass `source` through unchanged, adding a bare `session_status` each time
 * `intervalMs` passes with no event while no tool call is open.
 *
 * @param source - The turn's mapped events (`mapOpenCodeTurn`).
 * @param ctx - The turn's mapping context, read live for open tool calls.
 * @param intervalMs - Quiet time between signals; a test seam.
 */
export async function* withModelWaitLiveness(
  source: AsyncIterable<StreamEvent>,
  ctx: ModelWaitContext,
  intervalMs: number = MODEL_WAIT_LIVENESS_INTERVAL_MS
): AsyncGenerator<StreamEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<StreamEvent>> | null = iterator.next();
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const tick = new Promise<typeof TICK>((resolve) => {
        timer = setTimeout(() => resolve(TICK), intervalMs);
      });
      const winner = await Promise.race([pending, tick]).finally(() => clearTimeout(timer));
      if (winner === TICK) {
        if (!hasOpenToolCall(ctx)) {
          yield { type: 'session_status', data: { sessionId: ctx.sessionId } };
        }
        continue;
      }
      pending = null;
      if (winner.done) return;
      yield winner.value;
      pending = iterator.next();
    }
  } finally {
    if (pending === null) {
      await iterator.return?.();
    } else {
      pending.catch(() => {});
      void iterator.return?.()?.catch(() => {});
    }
  }
}

/**
 * {@link mapOpenCodeTurn} with {@link withModelWaitLiveness} around it: the
 * stream a live OpenCode turn hands to DorkOS.
 *
 * @param events - The turn's demuxed wire events.
 * @param ctx - The turn's mapping context (mutated by the mapper).
 */
export function mapLiveOpenCodeTurn(
  events: AsyncIterable<OpenCodeWireEvent>,
  ctx: OpenCodeEventContext
): AsyncGenerator<StreamEvent> {
  return withModelWaitLiveness(mapOpenCodeTurn(events, ctx), ctx);
}
