/**
 * Whether a chat's latest room turn answered someone from outside this machine (DOR-3440). A stamp
 * on what the turn saves, kept apart from the marks on purpose: it lowers nothing.
 *
 * @module services/core/turn-power/outside-words
 */

/** How many chats are remembered, oldest dropped first (as `turn-levels.ts`). */
const MEMORY = 10_000;

const chats = new Set<string>();

/**
 * Note what a room turn answers, on every turn, so the chat's next turn starts clean.
 *
 * @param sessionId - The chat.
 * @param outside - Whether any message it answers came from outside this machine.
 */
export function noteRoomTurnWords(sessionId: string, outside: boolean): void {
  chats.delete(sessionId);
  if (!outside) return;
  chats.add(sessionId);
  if (chats.size > MEMORY) chats.delete(chats.values().next().value!);
}

/**
 * Whether this chat's latest room turn answered someone from outside this machine.
 *
 * @param sessionId - The chat.
 */
export function roomTurnReadOutsideWords(sessionId: string): boolean {
  return chats.has(sessionId);
}
