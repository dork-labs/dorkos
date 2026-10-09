/** Dependency-free shared history paging policy for readers and capability metadata. */
/**
 * The most entries either history tool will return in one page
 * (room-participation spec §10.3).
 *
 * **A clamp, never a refusal.** An agent that asks for a thousand messages is not
 * making an error a `400` would teach it anything about; it wants as much as it
 * can have, and the useful answer is the most that is sensible plus a cursor to
 * ask again with. Two hundred is roughly a long afternoon in a busy channel and
 * still a page a model can hold.
 */
export const HISTORY_PAGE_MAX = 200;

/**
 * Bring a requested page size inside {@link HISTORY_PAGE_MAX}, and above zero.
 *
 * @param limit - What the caller asked for.
 * @returns A page size the store will accept.
 */
export function clampHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return HISTORY_PAGE_MAX;
  return Math.min(HISTORY_PAGE_MAX, Math.max(1, Math.floor(limit)));
}
