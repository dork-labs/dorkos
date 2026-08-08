/**
 * Read state — Transport methods (team-room-home spec §D4).
 *
 * Its own module rather than more surface on `room-methods.ts`: the same route
 * carries a room's cursor, a session's and the inbox's, and two of those three
 * are not rooms.
 *
 * @module shared/lib/transport/read-cursor-methods
 */
import type { ReadCursor, ReadCursorThreadKind } from '@dorkos/shared/read-cursor-schemas';
import { fetchJSON } from './http-client';

/** Create the read-state methods bound to a base URL. */
export function createReadCursorMethods(baseUrl: string) {
  return {
    setReadCursor(
      threadKind: ReadCursorThreadKind,
      threadId: string,
      lastReadSeq: number
    ): Promise<ReadCursor> {
      return fetchJSON<ReadCursor>(
        baseUrl,
        `/read-cursors/${threadKind}/${encodeURIComponent(threadId)}`,
        { method: 'PUT', body: JSON.stringify({ lastReadSeq }) }
      );
    },
  };
}
