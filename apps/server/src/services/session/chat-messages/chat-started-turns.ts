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
 * Filing id → the chats whose messages started that turn, so a tool call in
 * it can ask who started it (DOR-3703, M7: a turn a scheduled run's message
 * started counts as that run). Kept and dropped with {@link turns}.
 */
const senders = new Map<string, readonly string[]>();

/**
 * The chats whose messages started the chat's running turn, or none when
 * nothing but a person or a schedule started it.
 *
 * @param sessionId - The chat, by either id it is known by.
 */
export function chatTurnSendersOf(sessionId: string): readonly string[] {
  const key = primaryOf(sessionId);
  return [...(senders.get(key) ?? []), ...(wakers.get(key) ?? [])];
}

/**
 * Filing id → the chats whose room posts woke that chat's room turn (DOR-3703,
 * M7: a room turn a scheduled run's post woke counts as that run). Replaced by
 * each room turn of the chat, and kept through a person's later turn on it, the
 * stricter reading.
 */
const wakers = new Map<string, readonly string[]>();

/**
 * Another chat's message joined this chat's running turn (`steer`): the turn
 * now carries that chat's words too (M7).
 *
 * @param sessionId - The chat whose turn it joined.
 * @param fromSessionIds - The chats the message came from.
 */
export function noteSteeredInto(sessionId: string, fromSessionIds: readonly string[]): void {
  const key = primaryOf(sessionId);
  const known = senders.get(key) ?? [];
  senders.set(key, [...known, ...fromSessionIds.filter((id) => !known.includes(id))]);
}

/**
 * A room turn is starting on this chat, woken by these posts' writers (M7). A
 * person's post has no chat, and wakes nothing.
 *
 * @param sessionId - The chat the room turn runs on.
 * @param postSessionIds - The chats that wrote the posts it answers, `null` for a person's.
 */
export function noteRoomTurnWakers(
  sessionId: string,
  postSessionIds: readonly (string | null | undefined)[]
): void {
  const ids = postSessionIds.filter((id): id is string => !!id && id !== sessionId);
  wakers.set(primaryOf(sessionId), ids);
}

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
 * @param messages - The messages it carries, by the chat each came from.
 */
export function noteChatTurnStarted(
  sessionId: string,
  at: number,
  messages: readonly { fromSessionId: string }[] = []
): void {
  turns.set(primaryOf(sessionId), at);
  senders.set(
    primaryOf(sessionId),
    messages.map((m) => m.fromSessionId)
  );
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
    if (turns.get(key) !== startedAt) return;
    turns.delete(key);
    senders.delete(key);
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
  senders.delete(primaryOf(sessionId));
}

/**
 * Forget every chat-started turn.
 *
 * @internal Exported for testing only — the map outlives one test.
 */
export function resetChatStartedTurns(): void {
  turns.clear();
  senders.clear();
  wakers.clear();
}
