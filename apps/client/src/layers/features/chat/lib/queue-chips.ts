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
  unsupported: "Queued. This agent can't take a message mid-task.",
  // Deliberately not "queued as your next message": it lands BEHIND whatever is
  // already waiting, and naming a position the chip cannot know would be a
  // second small lie in the sentence written to stop the first one.
  'not-steerable': "Couldn't cut in. It's waiting in line.",
  // Quiet on purpose, like `session-idle` and for the same reason: nothing was
  // lost, and the person has ALREADY been told. A stage that folds joins no
  // queue — it has no row for a chip to hang on — and the transcript says
  // "Added context for the next reply" above the words themselves. A second
  // sentence here would be a duplicate at best, and at worst it would imply a
  // failure where the design simply chose the later of two honest routes.
  'not-stageable': null,
  // Says who is holding the task, and nothing about whether it finished. The
  // sentence this replaced — "Queued. The task had already finished." — asserted
  // an ending the server had never checked for, and a person watching the task
  // run in their other window was told it was over (DOR-1315).
  'turn-owned-elsewhere': "Couldn't cut in. Another window is running this task.",
  'pending-interaction': 'Queued. The agent needs your answer first.',
};

/**
 * What to say on a chip about a message that was not delivered the way it was
 * asked for, or `null` when there is nothing worth saying.
 *
 * Now that steer and stage have real mechanisms (P4), a downgrade is a live
 * event: a steer the runtime could not honour is queued instead, and the chip
 * owns up to it once — `unsupported`, `not-steerable`, `turn-owned-elsewhere`, and
 * `pending-interaction` each get one plain line. Two are deliberately quiet:
 * `session-idle`, because "it ran immediately" is not a loss anybody needs told,
 * and `not-stageable`, because a folded stage sits on no queue and the transcript
 * already shows what was added. Returns `null` for a clean delivery and for both
 * quiet cases alike.
 *
 * `not-steerable` is the reason `session-idle` used to swallow (DOR-1268): a
 * turn was running and could not be joined, so the message really did go to the
 * back of the line and staying quiet about it was a lie.
 *
 * @param outcome - The delivery receipt for a waiting message, if one was kept.
 */
export function queueDowngradeNotice(outcome: MessageDeliveryOutcome | undefined): string | null {
  if (!outcome?.degradedBecause) return null;
  return DOWNGRADE_NOTICE[outcome.degradedBecause];
}
