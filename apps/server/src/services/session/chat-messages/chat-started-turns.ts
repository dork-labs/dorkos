/**
 * Chats whose running turn another chat's message started (spec
 * `spin-off-chats` §6). Read by the turn-finished notification, so a turn
 * agents started for each other never notifies the person.
 *
 * Its own module, with nothing heavier than the session-key registry behind
 * it, because the notification emitters read it and the dispatcher's import
 * graph reaches those emitters: importing the chat-message service from there
 * would close a cycle through the dispatcher.
 *
 * Keyed by the id the dispatcher files a chat under ({@link primaryOf}), so a
 * chat that gained its canonical id mid-turn still matches. An entry is kept a
 * moment past the turn's end, because the "finished" status change and the
 * dispatcher's settle can arrive in either order, and cleared at once when a
 * turn no chat message rides on (a person's) begins.
 *
 * @module services/session/chat-messages/chat-started-turns
 */
import { primaryOf } from '../resolution/session-key-registry.js';

/** How long a chat-started turn is remembered after it settles. */
export const CHAT_TURN_LINGER_MS = 10_000;

/** Filing id → when the chat-started turn began. */
const turns = new Map<string, number>();

/**
 * Whether the chat's latest turn was started by another chat's message.
 *
 * @param sessionId - The chat, by either id it is known by.
 */
export function isChatStartedTurn(sessionId: string): boolean {
  return turns.has(primaryOf(sessionId));
}

/**
 * A turn another chat's message started has begun.
 *
 * @param sessionId - The chat.
 * @param at - When, epoch ms.
 */
export function noteChatTurnStarted(sessionId: string, at: number): void {
  turns.set(primaryOf(sessionId), at);
}

/**
 * A chat-started turn settled: forget it once the linger passes, unless
 * another chat-started turn began in the meantime.
 *
 * @param sessionId - The chat.
 */
export function noteChatTurnSettled(sessionId: string): void {
  const key = primaryOf(sessionId);
  const startedAt = turns.get(key);
  if (startedAt === undefined) return;
  const timer = setTimeout(() => {
    if (turns.get(key) === startedAt) turns.delete(key);
  }, CHAT_TURN_LINGER_MS);
  timer.unref?.();
}

/**
 * A turn no chat message rides on began (a person's, a schedule's): its finish
 * is somebody's to hear about, whatever the turn before it was.
 *
 * @param sessionId - The chat.
 */
export function noteOtherTurnStarted(sessionId: string): void {
  turns.delete(primaryOf(sessionId));
}

/**
 * Forget every chat-started turn.
 *
 * @internal Exported for testing only — the map outlives one test.
 */
export function resetChatStartedTurns(): void {
  turns.clear();
}
