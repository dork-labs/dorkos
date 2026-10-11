import { AGENT_PAUSED_CODE } from '@dorkos/shared/mesh-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import type { SessionStateProjector } from '../session-state-projector.js';

/**
 * The `seq`-less shape of a single {@link SessionEvent} member, selected by its
 * `type` discriminator. Distributing `Extract` before `Omit` preserves each
 * member's full field set so object literals type-check precisely (a bare
 * `Omit<SessionEvent, 'seq'>` collapses the union to its common keys).
 */
type RawOf<T extends SessionEvent['type']> = Omit<Extract<SessionEvent, { type: T }>, 'seq'>;

/**
 * Yield through a source generator, invoking `onEvent` just before EACH event is
 * forwarded, and guaranteeing at least one invocation if the source ends or
 * throws without yielding (so the canonical-id wait never hangs on an empty or
 * immediately-failing stream). Callers make their callbacks idempotent — the
 * canonical-id signal resolves once and the rekey retry disarms itself.
 *
 * @param source - The stream to forward.
 * @param onEvent - Fired just before each event; also once if the stream ends
 *   or throws without yielding.
 * @internal Exported so {@link import('./trigger-command-intent').triggerCommandIntent}
 * proves its own liveness to the lock off the same seam.
 */
export async function* tapEachEvent(
  source: AsyncIterable<StreamEvent>,
  onEvent: () => void
): AsyncIterable<StreamEvent> {
  let fired = false;
  try {
    for await (const event of source) {
      fired = true;
      onEvent();
      yield event;
    }
  } finally {
    // Empty stream or a throw before the first yield still releases the waiter.
    if (!fired) onEvent();
  }
}

/**
 * The error a turn refused because its agent is paused rides the stream as:
 * its own code, the agent's id in `reason` (the app offers Resume for it), and
 * no category or stack, because nothing broke (spec `audit-trail` PR5). Read
 * by its code, so this module need not load the pause service. `undefined`
 * for every other failure.
 */
function pausedErrorEvent(err: unknown): StreamEvent | undefined {
  if (!(err instanceof Error) || (err as Error & { code?: unknown }).code !== AGENT_PAUSED_CODE) {
    return undefined;
  }
  const agentId = (err as Error & { agent?: { id?: unknown } }).agent?.id;
  return {
    type: 'error',
    data: {
      message: err.message,
      code: AGENT_PAUSED_CODE,
      ...(typeof agentId === 'string' ? { reason: agentId } : {}),
    },
  };
}

/**
 * Forward a turn's `StreamEvent`s, translating a source throw into a clean
 * terminal sequence so `feedProjector` never sees a rejection (it would emit a
 * reason-less `turn_end` from its own `finally` AND leave the consumer racing a
 * second close). On a mid-stream throw this:
 *   1. ingests an `error` `status_change` DIRECTLY (lifecycle has no StreamEvent
 *      carrier, so the normalizer cannot express it), then
 *   2. yields a typed `error` StreamEvent (code `turn_exception`), so thrown and
 *      adapter-yielded errors converge on the durable stream: live clients
 *      render the failure inline and the projector latches
 *      `SessionStatus.lastError`, then
 *   3. yields a final `done` bearing `terminalReason: 'error'`, which
 *      `feedProjector` maps to the single closing `turn_end{terminalReason:'error'}`,
 * leaving the durable stream with `…status_change(error), error, turn_end(error)` —
 * never a frozen `streaming`. The original error is reported via `onError`.
 *
 * Exported so the command-intent trigger ({@link
 * import('./trigger-command-intent').triggerCommandIntent}) drives its adapter
 * generator through the SAME error-terminal translation a turn uses.
 *
 * @param projector - The session projector (for the direct error-status ingest).
 * @param source - The runtime's per-turn `StreamEvent` stream.
 * @param onError - Records the original failure (logging is the caller's concern).
 * @internal Exported for testing only.
 */
export async function* guardTurnErrors(
  projector: SessionStateProjector,
  source: AsyncIterable<StreamEvent>,
  onError: (err: unknown) => void
): AsyncIterable<StreamEvent> {
  try {
    yield* source;
  } catch (err) {
    onError(err);
    // lifecycle has no StreamEvent carrier, so ingest the error status directly.
    const errorStatus: RawOf<'status_change'> = {
      type: 'status_change',
      status: { lifecycle: 'error' },
    };
    projector.ingest(errorStatus);
    // The typed error rides the stream (unlike the status ingest above) so the
    // normalizer projects it onto the turn: rendered inline live, latched into
    // SessionStatus.lastError, and reconstructed into log-backed history.
    const errorMessage = err instanceof Error ? err.message : String(err);
    yield pausedErrorEvent(err) ?? {
      type: 'error',
      data: {
        message: errorMessage,
        code: 'turn_exception',
        // A thrown auth error (revoked/expired sign-in) still classifies so the
        // client offers a re-auth affordance rather than a generic failure.
        category: detectAuthError({ message: errorMessage }) ? 'auth_error' : 'execution_error',
        ...(err instanceof Error && err.stack ? { details: err.stack } : {}),
      },
    };
    // session_status carries the terminalReason feedProjector attaches to the
    // closing turn_end; the trailing done triggers that single turn_end.
    yield {
      type: 'session_status',
      data: { sessionId: projector.sessionId, terminalReason: 'error' },
    };
    yield { type: 'done', data: { sessionId: projector.sessionId } };
  }
}
