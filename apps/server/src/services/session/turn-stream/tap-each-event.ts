/**
 * The per-event tap every turn runs its stream through, and the log line a
 * runtime's own error writes as it passes (DOR-3167).
 *
 * Its own module so `trigger-turn.ts` stays within the size rule. All three turn
 * paths share it: `triggerTurn`, `triggerCommandIntent` and the runtime turn.
 *
 * @module services/session/turn-stream/tap-each-event
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';

/**
 * Yield through a source generator, invoking `onEvent` just before EACH event is
 * forwarded, and guaranteeing at least one invocation if the source ends or
 * throws without yielding (so the canonical-id wait never hangs on an empty or
 * immediately-failing stream). Callers make their callbacks idempotent — the
 * canonical-id signal resolves once and the rekey retry disarms itself.
 *
 * @param source - The stream to forward.
 * @param onEvent - Fired just before each event, with that event; also once,
 *   with none, if the stream ends or throws without yielding.
 */
export async function* tapEachEvent(
  source: AsyncIterable<StreamEvent>,
  onEvent: (event?: StreamEvent) => void
): AsyncIterable<StreamEvent> {
  let fired = false;
  try {
    for await (const event of source) {
      fired = true;
      onEvent(event);
      yield event;
    }
  } finally {
    // Empty stream or a throw before the first yield still releases the waiter.
    if (!fired) onEvent();
  }
}

/**
 * Write a runtime's refusal or error to the server log (DOR-3167). A refused turn
 * throws nothing, so without this its only record is the chat itself.
 *
 * @param event - One event of the turn.
 * @param sessionId - The session the turn runs in.
 * @param runtime - Which runtime is running it.
 */
export function warnOnRuntimeError(
  event: StreamEvent,
  sessionId: string,
  runtime: string | undefined
): void {
  if (event.type !== 'error') return;
  const { message, code, category } = event.data as {
    message: string;
    code?: string;
    category?: string;
  };
  logger.warn('[turn] the runtime reported an error', {
    sessionId,
    runtime: runtime ?? null,
    code: code ?? null,
    category: category ?? null,
    message,
  });
}
