/**
 * The composer's session-context key — the one string that says "which
 * conversation, in which project, is this composer looking at right now".
 *
 * Several pieces of composer state must be dropped in lockstep whenever that
 * answer changes: the queue's editing cursor and owed flush (`useMessageQueue`),
 * and the parked draft plus the edit handoff (`useChatQueue`). Their correctness
 * depends on all of them agreeing character-for-character about when the context
 * changed — a coarser key on one of them left the editing cursor reset while a
 * queued message's body stayed in the composer, where the next Enter sent it a
 * second time (DOR-480). They were built independently in two files and kept in
 * agreement by comment; this makes that structural instead.
 *
 * @module features/chat/lib/session-context-key
 */

/**
 * Build the composer's context key for a session + working directory.
 *
 * A space is a safe delimiter even though a path may contain one: every session
 * id is a `crypto.randomUUID()`, so the prefix is always exactly 36 characters
 * and everything after the first space is the cwd. The split point is therefore
 * fixed, and two distinct (sessionId, cwd) pairs cannot collide however many
 * spaces the path has.
 *
 * Previously `\x00`, which is unrepresentable in either component — but a NUL
 * byte makes git treat the file as binary, so the riskiest change in a PR showed
 * as zero diff lines and no reviewer could read it. A readable diff is worth more
 * than a delimiter that cannot appear.
 *
 * @param sessionId - The active session id, or `null` when none is selected.
 * @param cwd - The selected working directory, or `null`.
 * @returns The key, or `null` when there is no session to scope to.
 */
export function sessionContextKey(sessionId: string | null, cwd: string | null): string | null {
  return sessionId === null ? null : `${sessionId} ${cwd ?? ''}`;
}
