/**
 * Query key factory for the session entity. Every reader and writer of a
 * session's cached detail row builds its key here, so a reader can never end up
 * looking in a cache entry no writer fills — `getQueryData` matches keys
 * exactly, and a hand-written key that dropped the working directory silently
 * read `undefined` forever (DOR-482).
 *
 * @module entities/session/api/query-keys
 */
export const sessionKeys = {
  /** Root key for every session query. */
  all: ['session'] as const,
  /**
   * Prefix covering every cached entry for one session, whatever working
   * directory it was fetched under. For invalidation only — `invalidateQueries`
   * matches by prefix, `getQueryData` does not.
   *
   * @param sessionId - The session id.
   */
  bySession: (sessionId: string) => [...sessionKeys.all, sessionId] as const,
  /**
   * The exact key holding one session's detail row.
   *
   * @param sessionId - The session id, or null when none is selected.
   * @param cwd - The selected working directory the row was fetched for.
   */
  detail: (sessionId: string | null, cwd: string | null) =>
    [...sessionKeys.all, sessionId, cwd] as const,
};
