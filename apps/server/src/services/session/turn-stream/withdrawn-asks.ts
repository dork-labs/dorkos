/**
 * How an ask that nobody answered leaves the stream: the resolution a runtime's
 * `interaction_cancelled` projects to, and the withdrawal of every ask a failed
 * turn left behind (DOR-3210). Split out of `session-event-normalizer.ts`,
 * which is past the line ceiling.
 *
 * @module services/session/turn-stream/withdrawn-asks
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SessionStateProjector } from '../session-state-projector.js';
import { liveChildren } from './stranded-children.js';

type Resolution = Extract<SessionEvent, { type: 'interaction_resolved' }>['resolution'];

/**
 * Map an `interaction_cancelled` event's `reason` to the resolution its
 * `interaction_resolved` projection carries (DOR-1148). `approved`/`denied`
 * name a real answer (an OpenCode `permission.replied` echo reporting an
 * answer given outside DorkOS); `timeout` names an answer the system gave on
 * the person's behalf. Anything else — including the ordinary `aborted` and a
 * reason a future runtime has not taught this function yet — is a withdrawal,
 * not an answer, so it defaults to `cancelled` rather than inventing a receipt.
 */
export function resolutionForCancelledReason(reason: unknown): Resolution {
  if (reason === 'timeout') return 'expired';
  if (reason === 'approved') return 'approved';
  if (reason === 'denied') return 'denied';
  return 'cancelled';
}

/**
 * Withdraw every ask still pending when a turn closes in an error (DOR-3210).
 *
 * The runtime withdraws an ask itself when its turn is torn down — claude-code
 * pushes an `interaction_cancelled { reason: 'aborted' }` from the SDK's abort —
 * but onto an event queue nobody drains once the stream has failed. Left alone,
 * the card stayed a live button for the whole park ceiling: the room counted it
 * as waiting on a person, the Needs-you surfaces listed it, and approving it
 * answered a tool call whose turn had already died. This says what the runtime
 * meant to say, with the resolution its own withdrawal projects to; the turn's
 * error is what tells the person what happened and what to try.
 *
 * A turn that ended cleanly is not this function's business, and a turn whose
 * runtime still sees a helper running is spared: a background helper's ask
 * outlives the turn that started it, and stays answerable while the helper does.
 *
 * @param projector - The session's projector.
 * @param stillLive - What the runtime still sees running, as for
 *   `sweepStrandedChildren`.
 */
export function retireStrandedAsks(
  projector: SessionStateProjector,
  stillLive: (() => readonly string[]) | undefined
): void {
  if (liveChildren(stillLive).length > 0) return;
  for (const { id } of projector.getPendingInteractions()) {
    const withdrawn: Omit<Extract<SessionEvent, { type: 'interaction_resolved' }>, 'seq'> = {
      type: 'interaction_resolved',
      id,
      resolution: resolutionForCancelledReason('aborted'),
      at: Date.now(),
    };
    projector.ingest(withdrawn);
  }
}
