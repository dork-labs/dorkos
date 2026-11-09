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

/** Room posts an agent wrote from a chat that had read outside words, newest kept. */
const posts = new Set<string>();

/**
 * Keep a room post's outside words with it when its writer's chat had read some (DOR-4023): marks
 * spread through agent hops, so the turn the post wakes counts them as its own. Called as the post
 * is written, before anything it triggers is dispatched. Kept in memory, like the levels: a room's
 * pending replies don't outlive the process.
 *
 * @param entryId - The post.
 * @param writers - The chats that wrote or vouch for it.
 */
export function carryRoomPostWords(
  entryId: string,
  writers: readonly (string | null | undefined)[]
): void {
  if (!writers.some((sessionId) => typeof sessionId === 'string' && chats.has(sessionId))) return;
  posts.add(entryId);
  if (posts.size > MEMORY) posts.delete(posts.values().next().value!);
}

/**
 * Whether a room post carries outside words its writer's chat had read.
 *
 * @param entryId - The post.
 */
export function roomPostCarriesOutsideWords(entryId: string): boolean {
  return posts.has(entryId);
}
