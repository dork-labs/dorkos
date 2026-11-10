/**
 * The one check `transcript_read` makes of a session id before anything uses it.
 *
 * @module services/audit/plain-session-id
 */

/**
 * Whether a session id is a single plain name, safe to put in a file path.
 *
 * A runtime builds its transcript path from the id (`<id>.jsonl`), so an id
 * that names a folder, climbs one (`..`), or hides either behind percent
 * encoding or a NUL is refused before any runtime sees it (DOR-4060). Every
 * runtime's real ids (UUIDs, `ses_…`) are plain names.
 *
 * @param sessionId - The id a caller named.
 */
export function isPlainSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId !== '.' && !/[/\\%\0]|\.\./.test(sessionId);
}
