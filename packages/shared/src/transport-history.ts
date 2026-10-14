/**
 * Reading a session's message history, as the client reaches it. A slice of
 * the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-history
 */
import type { HistoryRead, HistoryReadQuery } from './schemas.js';

/** Read a session's history whole, or one part of it. */
export interface HistoryTransport {
  /**
   * Fetch message history for a session. With `page.since` (a message id) the
   * server answers only that message and those after it, marked `tail`, when
   * it still has that message; otherwise the whole history. With `page.before`
   * (a message id) it answers the page of up to `HISTORY_PAGE_LIMIT` messages
   * directly older than that one, and how many remain before it. With
   * `page.newest` it answers the newest `HISTORY_WINDOW_LIMIT` messages, as the
   * stream's snapshot carries them, and how many come before.
   */
  getMessages(sessionId: string, cwd?: string, page?: HistoryReadQuery): Promise<HistoryRead>;
}
