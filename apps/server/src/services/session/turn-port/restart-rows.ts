/**
 * What recovery does to the queue row of a turn a restart cut before the
 * runtime read its words (spec `turns-survive-restarts` §7.3, step 4): the
 * row the turn kept (`in_turn`) is handed back to a person as a restored
 * draft, or, when another sender's words are in it, taken away with its
 * sender told through its own path. Never replayed either way.
 *
 * Each write joins the transaction the run record has open (one
 * `better-sqlite3` connection), so the row and the run's decision commit
 * together. Every window hears the queue after the commit.
 *
 * @module services/session/turn-port/restart-rows
 */
import { getMessageQueueStore } from '../message-queue-store.js';
import { emitQueueUpdate } from '../queue-stream-events.js';
import { emitLifecycle } from '../message-dispatcher/state.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';

/** Tell every window the chat's queue changed, once the write that changed it has committed. */
function announceQueue(chatKey: string): void {
  queueMicrotask(() => emitQueueUpdate(queueKeyOf(chatKey)));
}

/**
 * Hand a person's words back as a restored draft: the row the turn kept is
 * listed and flagged, never started by the pump or adopted (§4.6).
 *
 * @param chatKey - The chat, by any id it answers to.
 * @param queueMessageId - The row.
 * @returns Whether a row kept for its turn was restored.
 */
export function restoreDraftRow(chatKey: string, queueMessageId: string): boolean {
  const restored = getMessageQueueStore()?.markRestored(queueMessageId) ?? false;
  if (restored) announceQueue(chatKey);
  return restored;
}

/**
 * Take away a row whose words another sender wrote (an agent, another chat, a
 * mini app): they are never replayed and never shown as a person's draft.
 *
 * @param chatKey - The chat, by any id it answers to.
 * @param queueMessageId - The row.
 * @returns Whether a row was removed.
 */
export function dropKeptRow(chatKey: string, queueMessageId: string): boolean {
  const removed = getMessageQueueStore()?.remove(queueMessageId) !== undefined;
  if (removed) announceQueue(chatKey);
  return removed;
}

/**
 * Tell a message's sender its turn ended without an answer, as the
 * dispatcher's own settle tells it: another chat's message reads as failed
 * in that chat's sends. Told after the write that decided it has committed.
 *
 * @param chatKey - The chat the message was sent to, by any id it answers to.
 * @param messageId - The message: its queue row's id.
 */
export function tellSenderTurnLost(chatKey: string, messageId: string): void {
  queueMicrotask(() =>
    emitLifecycle({
      phase: 'settled',
      messageId,
      sessionId: queueKeyOf(chatKey),
      outcome: 'failed',
    })
  );
}
