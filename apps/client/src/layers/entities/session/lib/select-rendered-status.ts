/**
 * The one mapping from a session's server-projected lifecycle onto the coarse
 * {@link ChatStatus} the UI renders (spec chat-stream-reconnection).
 *
 * It lives at the entity level rather than inside the chat feature because two
 * unrelated surfaces need the same answer to "is a turn in flight?" — the chat
 * renderer and the Session readout — and a second implementation would be free to
 * drift. Both route through {@link renderedStatusFrom}: the renderer already
 * holds the whole projection and calls {@link selectRenderedStatus}; a readout
 * that only wants the answer subscribes to the two fields via
 * `useSessionRenderedStatus`.
 *
 * @module entities/session/lib/select-rendered-status
 */
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { ChatStatus } from '@/layers/shared/model';
import type { SessionStreamState } from '../model/stream/session-stream-store';

/**
 * Map a projected lifecycle onto the renderer's coarse {@link ChatStatus}.
 *
 * `streaming` → `streaming`; `error` → `error`; `idle`/`blocked`/`interrupted`
 * collapse to `idle` (the renderer expresses blocked/interrupted via pending
 * interactions and the interrupted-turn chip, not the coarse status).
 *
 * A pending trigger reads as `streaming` (CLI-B7): the POST is a 202 trigger,
 * so between Enter and the server's `turn_start` the lifecycle still says
 * `idle` — without this the composer would accept a second Enter as a
 * duplicate send instead of queueing it.
 *
 * @param lifecycle - The projected lifecycle, or `undefined` before hydration.
 * @param triggerPending - Whether a turn trigger is in flight.
 * @param legacyStatus - The legacy send-path status (pre-hydration fallback).
 */
export function renderedStatusFrom(
  lifecycle: SessionLifecycle | undefined,
  triggerPending: boolean,
  legacyStatus: ChatStatus
): ChatStatus {
  if (triggerPending) return 'streaming';
  if (lifecycle === undefined) return legacyStatus;
  switch (lifecycle) {
    case 'streaming':
      return 'streaming';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * {@link renderedStatusFrom} applied to a whole stream projection — the form the
 * chat renderer uses, since it already holds the state.
 *
 * @param stream - The per-session durable-stream projection.
 * @param legacyStatus - The legacy send-path status (transitional fallback).
 */
export function selectRenderedStatus(
  stream: SessionStreamState,
  legacyStatus: ChatStatus
): ChatStatus {
  return renderedStatusFrom(stream.status?.lifecycle, stream.triggerPending, legacyStatus);
}
