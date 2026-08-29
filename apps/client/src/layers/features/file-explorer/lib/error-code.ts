/**
 * Read the stable `code` a transport attaches to a refusal.
 *
 * Both adapters decorate every thrown error with the server's code, which is
 * how the UI tells one refusal from another without reading its sentence —
 * sentences are copy and change; codes are contract. This is the uncoloured
 * read: it hands back whatever code is there, for callers whose codes come from
 * somewhere other than the files API (a room refusing "this room has no files
 * of its own", say).
 *
 * @module features/file-explorer/lib/error-code
 */

/**
 * The `code` on a thrown error, or `undefined` when there isn't one.
 *
 * @param err - Anything that was thrown.
 */
export function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** The room's answer to "show me your files" when it has none of its own. */
export const ROOM_HAS_NO_REPO_CODE = 'ROOM_HAS_NO_REPO';
