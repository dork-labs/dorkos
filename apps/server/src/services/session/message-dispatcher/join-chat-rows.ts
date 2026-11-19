/**
 * Joining adjacent agent messages only when the queue drains.
 *
 * Every send keeps its own durable row while it waits. Just before the head is
 * read into a turn, this folds the contiguous chat rows behind it into that
 * head. A person's row, a non-queue disposition, a launch already under way,
 * or the size ceiling ends the join.
 *
 * @module services/session/message-dispatcher/join-chat-rows
 */
import { CHAT_MESSAGE_MAX, isChatClientId } from '../chat-messages/chat-client-id.js';
import { getMessageQueueStore, setQueuedWaitingOn } from '../message-queue-store.js';
import { emitQueueUpdate } from '../queue-stream-events.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import {
  launching,
  pending,
  queuedChatJoinIsWired,
  repointQueuedChatJoin,
  steering,
} from './state.js';

/** The largest combined prompt a drain join may build. */
export const CHAT_DRAIN_JOIN_MAX = 5 * CHAT_MESSAGE_MAX;

/**
 * Fold contiguous waiting chat rows behind the launching head into its turn.
 *
 * The joined rows' timers are disarmed without a lifecycle drop, and their
 * callers are settled as answered, not abandoned. Their chat-message records
 * move to the head first, so the head's normal start and settlement events
 * settle all of them together, and the head's launch reads every sender's
 * ceiling, hold and words from them.
 *
 * @param sessionId - The session whose queue is draining.
 * @param headRowId - The chat row about to launch.
 */
export function joinWaitingChatRows(sessionId: string, headRowId: string): void {
  const store = getMessageQueueStore();
  if (!store) return;
  const rows = store.list(queueKeyOf(sessionId));
  const headIndex = rows.findIndex((row) => row.id === headRowId);
  const head = rows[headIndex];
  if (headIndex !== 0 || !head || !isChatClientId(head.enqueuedBy) || !queuedChatJoinIsWired()) {
    return;
  }

  let content = head.content;
  let joined = false;
  for (const next of rows.slice(headIndex + 1)) {
    if (
      !isChatClientId(next.enqueuedBy) ||
      next.disposition !== 'queue' ||
      launching.has(next.id) ||
      steering.has(next.id) ||
      // A row held to the default joins only a head held the same way: the
      // head's flag is the one the joined turn launches under.
      (next.heldToDefault === true && head.heldToDefault !== true) ||
      // And only a head that kept the same limits (DOR-4350): the joined turn launches under
      // the head's, and a row's mark, ceiling or unattended answer must not be dropped.
      JSON.stringify(next.carriedLimits) !== JSON.stringify(head.carriedLimits)
    ) {
      break;
    }
    const combined = `${content}\n\n${next.content}`;
    if (combined.length > CHAT_DRAIN_JOIN_MAX) break;
    // One transaction: a process that dies mid-fold must never leave the
    // head holding these words while their own row still waits to run them.
    if (!store.get(headRowId) || !store.get(next.id)) break;
    store.atomically(() => {
      store.updateContent(headRowId, combined);
      repointQueuedChatJoin(next.id, headRowId);
      store.remove(next.id);
    });
    const waiting = pending.get(next.id);
    if (waiting) clearTimeout(waiting.timer);
    pending.delete(next.id);
    setQueuedWaitingOn(next.id, undefined);
    // Its words go out with the head's turn: whatever its caller holds until
    // the turn settles (a launch-cap slot, a debug-buffer entry) is released.
    waiting?.folded();
    content = combined;
    joined = true;
  }
  if (joined) emitQueueUpdate(sessionId);
}
