/**
 * Editing what is waiting: the queue's mutation API, used by the queue routes
 * (spec `persistent-session-runtime` §3.3, task 2.4).
 *
 * Deliberately NOT in `message-dispatcher.ts`. That module answers one question
 * — when does a message become a turn — and these answer a different one: what a
 * person may do to a message while it waits. They sit on top of the store and
 * the dispatcher rather than inside either, and the routes call nothing else.
 *
 * **The queue belongs to the SESSION, not to a window.** Any client may edit or
 * remove any message on it; that is the whole point of moving the queue off the
 * client (ADR-0104's local FIFO was invisible to a second window). `enqueuedBy`
 * exists so a window can SAY which chips are its own, never so the server can
 * refuse the others. A row this process ADOPTED after a restart is editable on
 * exactly the same terms — it is a real row with a real pending entry behind it.
 *
 * Every mutation here announces the whole queue through `emitQueueUpdate`, like
 * every other queue change, so the other windows learn about it on the same
 * durable stream that carries the turn itself.
 *
 * @module services/session/queued-message-edits
 */
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { getMessageQueueStore, toQueuedMessage } from './message-queue-store.js';
import type { MoveTarget } from './message-queue-store.js';
import { queueKeyOf } from './session-key-registry.js';
import {
  cancelPendingDispatch,
  emitQueueUpdate,
  listQueuedMessages,
} from './message-dispatcher.js';

/**
 * Whether `messageId` is waiting on `sessionId` right now.
 *
 * Asked of the SESSION rather than of the message, because a message id alone
 * would let one session's URL edit another session's queue. A message that is
 * not on this session's queue — dispatched, removed, or never here — is simply
 * not found.
 */
function isQueuedOn(sessionId: string, messageId: string): boolean {
  return listQueuedMessages(sessionId).some((row) => row.id === messageId);
}

/** What {@link editQueuedMessage} may change about a waiting message. */
export interface QueuedMessageEdit {
  /** Replacement words, stored pristine. */
  content?: string;
  /** Where to move it, relative to another message on the same queue. */
  move?: MoveTarget;
}

/**
 * Edit a waiting message's words, its place in the queue, or both, and announce
 * the result to every window.
 *
 * The queue belongs to the SESSION, not to whoever typed into it: any window may
 * edit any message on it, which is the whole point of moving the queue to the
 * server. A row this process ADOPTED after a restart is editable on exactly the
 * same terms — it is a real row on the real queue, and the pending entry that
 * runs it is keyed by the same id.
 *
 * `undefined` means nothing on this session's queue has that id, or a move named
 * an anchor that is not on it — both are a `404` at the route.
 *
 * @param sessionId - The session whose queue holds the message
 * @param messageId - The server-minted message id
 * @param edit - The words to replace, the move to make, or both
 */
export function editQueuedMessage(
  sessionId: string,
  messageId: string,
  edit: QueuedMessageEdit
): QueuedMessage | undefined {
  const store = getMessageQueueStore();
  if (!store || !isQueuedOn(sessionId, messageId)) return undefined;
  // The move goes FIRST: it is the only half that can be refused (a bogus or
  // cross-session anchor), and the reword cannot fail on a row already
  // confirmed present. Committing the reword before checking the move would
  // answer 404 while silently changing what the message says (DOR-1178).
  let record = edit.move ? store.move(messageId, edit.move) : store.get(messageId);
  if (record && edit.content !== undefined) record = store.updateContent(messageId, edit.content);
  if (record) emitQueueUpdate(sessionId);
  return record ? toQueuedMessage(record) : undefined;
}

/**
 * Take a waiting message off the queue, announce it, and hand it back.
 *
 * The pending dispatch goes with the row. Leaving it armed would fire the
 * message anyway one wait-bound later — the person removed it and it would run
 * regardless, which is the worst possible reading of a Remove — and an adopted
 * row's entry has to go the same way, since it is the same kind of entry.
 *
 * @param sessionId - The session whose queue holds the message
 * @param messageId - The server-minted message id
 */
export function cancelQueuedMessage(
  sessionId: string,
  messageId: string
): QueuedMessage | undefined {
  const store = getMessageQueueStore();
  if (!store || !isQueuedOn(sessionId, messageId)) return undefined;
  cancelPendingDispatch(messageId);
  const removed = store.remove(messageId);
  if (removed) emitQueueUpdate(sessionId);
  return removed ? toQueuedMessage(removed) : undefined;
}

/**
 * Empty a session's queue and hand every removed message back, in order.
 *
 * This is what a Stop does to the queue (spec `persistent-session-runtime` §3.5,
 * D4): "stop means stop everything queued." A person who pressed Stop and then
 * watched the next queued message fire has been lied to, so the whole queue goes
 * — but nothing they typed is destroyed. The returned rows travel back to the
 * composer as a draft, the same promise {@link cancelQueuedMessage}'s single-row
 * remove keeps (DOR-480).
 *
 * Two removals in lock-step, exactly as the single-row path pairs them:
 *
 * - **The in-memory pending dispatch of every waiting message is disarmed
 *   first.** `MessageQueueStore.clear` only deletes the durable rows; an armed
 *   pending entry runs from the plan it captured regardless of whether its row
 *   still exists, so clearing the store alone would still let the head fire one
 *   turn boundary later — precisely the "watched the next queued message fire"
 *   lie. Disarm before delete, never after.
 * - **A booting first turn's row is swept here too.** Such a row retires only on
 *   `turn_start` (`message-dispatcher.ts` `onTurnStart` → `store.remove`), which
 *   a boot stopped before it opens never reaches. Left in place it is re-adopted
 *   and re-run on the next dispatch (DOR-1192). Clearing the store row retires
 *   it, and `returnToQueue`'s own guard (it re-parks nothing whose row is
 *   already gone) keeps the interrupted launch from resurrecting it.
 *
 * Call this BEFORE the interrupt, so the turn ending there cannot let the pump
 * release the head of the queue on its way out.
 *
 * @param sessionId - The session whose queue to empty (request uuid or canonical)
 * @returns The removed messages, head first; empty when no store is wired or the
 *   queue was already empty
 */
export function clearQueuedMessages(sessionId: string): QueuedMessage[] {
  const store = getMessageQueueStore();
  if (!store) return [];
  const queueKey = queueKeyOf(sessionId);
  for (const row of store.list(queueKey)) cancelPendingDispatch(row.id);
  const removed = store.clear(queueKey);
  if (removed.length > 0) emitQueueUpdate(sessionId);
  return removed.map(toQueuedMessage);
}
