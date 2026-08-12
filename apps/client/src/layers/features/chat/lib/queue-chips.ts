/**
 * What the queue chips show — the two pure decisions between the server's queue
 * and the rows a person sees (spec `persistent-session-runtime`, task 2.6).
 *
 * @module features/chat/lib/queue-chips
 */
import type { MessageDeliveryOutcome, QueuedMessage } from '@dorkos/shared/schemas';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';

/**
 * The lifecycles in which a turn is genuinely open, so the messages behind it
 * are genuinely waiting.
 *
 * `blocked` counts: the turn is parked on a person (a permission ask, a
 * question), it has not ended, and the queue really is stuck behind it.
 */
const TURN_IS_OPEN: ReadonlySet<SessionLifecycle> = new Set<SessionLifecycle>([
  'streaming',
  'blocked',
]);

/**
 * The messages that are actually WAITING, out of everything the server has
 * queued for this session.
 *
 * The server puts every accepted message on the queue, including one it is
 * about to run immediately — the row only leaves when the turn actually starts.
 * That is right for the server (a message that has not started is a message
 * that can still be edited or taken back) and wrong to draw: an ordinary send
 * into an idle session would flash a "Queued (1)" panel for as long as the
 * runtime takes to start, which for a cold Claude Code process is seconds.
 *
 * So the head is drawn only while a turn is open to wait behind. With nothing
 * running, whatever is at the head is not waiting — it is on its way, and the
 * `queue_update` that follows its `turn_start` takes the row away for real.
 * Everything behind the head is waiting either way.
 *
 * @param queue - The session's queue, head first, as the server holds it.
 * @param lifecycle - The session's server-held lifecycle, or `undefined` before
 *   the first hydration (which is not a turn, so the head is on its way).
 */
export function selectWaitingQueue(
  queue: QueuedMessage[],
  lifecycle: SessionLifecycle | undefined
): QueuedMessage[] {
  if (queue.length === 0) return queue;
  return lifecycle && TURN_IS_OPEN.has(lifecycle) ? queue : queue.slice(1);
}

/** What each downgrade reason means, in words a chip can say. */
const DOWNGRADE_NOTICE: Record<
  NonNullable<MessageDeliveryOutcome['degradedBecause']>,
  string | null
> = {
  // "It ran immediately" is not a loss, and nobody needs telling about it.
  'session-idle': null,
  unsupported: 'Queued — this agent cannot take a message mid-task',
  'no-open-turn': 'Queued — the task had already finished',
  'pending-interaction': 'Queued — the agent is waiting on your answer first',
};

/**
 * What to say on a chip about a message that was not delivered the way it was
 * asked for, or `null` when there is nothing worth saying.
 *
 * Nothing says anything yet: every disposition resolves to `queue` until phase
 * 4 gives `steer` and `stage` real mechanisms, so the only reason in
 * circulation today is one this deliberately stays quiet about. The slot is
 * here so that when a downgrade becomes possible the chip already knows how to
 * own up to it, rather than quietly doing something other than what was asked.
 *
 * @param outcome - The delivery receipt for a waiting message, if one was kept.
 */
export function queueDowngradeNotice(outcome: MessageDeliveryOutcome | undefined): string | null {
  if (!outcome?.degradedBecause) return null;
  return DOWNGRADE_NOTICE[outcome.degradedBecause];
}
