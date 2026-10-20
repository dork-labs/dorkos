/**
 * Which conversation each agent post was written from, when that is not the
 * agent's own turn in the room (DOR-3107). An agent can post into a room from
 * another chat, a direct chat a person set to ask first, say. The post's own
 * `sessionId` names only its turn in this room, so the chat it really wrote
 * from is kept here, and the poster's cap reads that chat's setting too
 * (`posterCapsFor`).
 *
 * Kept in memory, bounded, like the other per-post records: a post read back
 * after a restart is held to its poster's own setting only.
 *
 * @module services/rooms/limits/caller-sessions
 */

/** How many posts are remembered; the oldest go first. */
const CALLER_SESSION_MEMORY = 10_000;

const callerSessions = new Map<string, string>();

/**
 * Remember the conversation a post was written from.
 *
 * @param entryId - The post.
 * @param sessionId - The session that made the call, as the server verified it.
 */
export function noteCallerSession(entryId: string, sessionId: string): void {
  callerSessions.delete(entryId);
  callerSessions.set(entryId, sessionId);
  if (callerSessions.size > CALLER_SESSION_MEMORY) {
    const oldest = callerSessions.keys().next().value;
    if (oldest !== undefined) callerSessions.delete(oldest);
  }
}

/**
 * The conversation a post was written from, when it was not the author's turn
 * in the room and this process saw the post written.
 *
 * @param entryId - The post.
 */
export function callerSessionOf(entryId: string): string | undefined {
  return callerSessions.get(entryId);
}

/**
 * Forget every post.
 *
 * @internal Exported for testing only.
 */
export function resetCallerSessions(): void {
  callerSessions.clear();
}
