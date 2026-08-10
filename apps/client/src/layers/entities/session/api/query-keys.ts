/**
 * Query key factory for the session entity. Every reader and writer of a cached
 * session builds its key here, so a reader can never end up looking in a cache
 * entry no writer fills — `getQueryData` matches keys exactly, and a
 * hand-written key that dropped the working directory silently read `undefined`
 * forever (DOR-482).
 *
 * There are three separate caches, and they must stay in three separate
 * namespaces:
 *
 * - **`detailRoot`** — one session's full row, keyed by session id + working
 *   directory. Also a sweep target: `syncSessionDetailCache` walks every entry
 *   under it and reads each one's `id` to decide whether a fresh server row
 *   covers it. So nothing whose value is NOT a single `Session` may live here —
 *   the same rule `listRoot` carries below, for the same reason it earned it.
 * - **`listRoot`** — the sessions in one working directory, as a bare array.
 *   The prefix is a live invalidation and sweep target, so nothing whose value
 *   is NOT a `Session[]` may live under it.
 * - **`recentRoot`** — the newest sessions across every agent, whose value is an
 *   envelope object, not an array. It sits outside `listRoot` for exactly that
 *   reason: the retired-session sweep rewrites every key under `listRoot` as an
 *   array, and used to walk straight into this one and throw (DOR-497).
 *
 * @module entities/session/api/query-keys
 */
export const sessionKeys = {
  /** Root of every single-session detail query. */
  detailRoot: ['session'] as const,
  /**
   * Prefix covering every cached detail entry for one session, whatever working
   * directory it was fetched under. For invalidation only — `invalidateQueries`
   * matches by prefix, `getQueryData` does not.
   *
   * @param sessionId - The session id.
   */
  bySession: (sessionId: string) => [...sessionKeys.detailRoot, sessionId] as const,
  /**
   * The exact key holding one session's detail row.
   *
   * @param sessionId - The session id, or null when none is selected.
   * @param cwd - The selected working directory the row was fetched for.
   */
  detail: (sessionId: string | null, cwd: string | null) =>
    [...sessionKeys.detailRoot, sessionId, cwd] as const,
  /**
   * Root of every per-directory session list. Every entry under this prefix
   * holds a `Session[]` — invalidation and the retired-session sweep both walk
   * it and assume so.
   */
  listRoot: ['sessions'] as const,
  /**
   * The exact key holding one working directory's session list.
   *
   * @param cwd - The working directory, or null for the default one.
   */
  list: (cwd: string | null) => [...sessionKeys.listRoot, cwd] as const,
  /** Root of the cross-agent recent-sessions query, for prefix invalidation. */
  recentRoot: ['recent-sessions'] as const,
  /**
   * The exact key holding one page of cross-agent recent sessions.
   *
   * @param limit - How many sessions the page asked for.
   */
  recent: (limit: number) => [...sessionKeys.recentRoot, limit] as const,
  /**
   * Root of the machine-wide daily session-count query (DOR-1039), for prefix
   * invalidation. Outside `listRoot` for the same reason `recentRoot` is: its
   * value is an envelope object, and everything under the list prefix is swept
   * as a `Session[]`.
   */
  dailyCountsRoot: ['session-daily-counts'] as const,
  /**
   * The exact key holding one window of machine-wide daily session counts.
   *
   * @param days - How many days the window covers.
   */
  dailyCounts: (days: number) => [...sessionKeys.dailyCountsRoot, days] as const,
};
