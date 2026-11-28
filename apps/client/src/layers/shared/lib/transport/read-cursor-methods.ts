/**
 * Read state — Transport methods (team-room-home spec §D4).
 *
 * Its own module rather than more surface on `room-methods.ts`: the same route
 * carries a room's cursor, a session's and the inbox's, and two of those three
 * are not rooms. Both calls go through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/read-cursor-methods
 */
import type { ReadCursor, ReadCursorThreadKind } from '@dorkos/shared/read-cursor-schemas';
import { createTransportApiClient } from './api-client';

/** Create the read-state methods bound to a base URL. */
export function createReadCursorMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async getReadCursor(
      threadKind: ReadCursorThreadKind,
      threadId: string
    ): Promise<ReadCursor | null> {
      const { cursor } = await api.call('readCursors.get', {
        path: { kind: threadKind, id: threadId },
      });
      return cursor;
    },

    setReadCursor(
      threadKind: ReadCursorThreadKind,
      threadId: string,
      lastReadSeq: number
    ): Promise<ReadCursor> {
      return api.call('readCursors.update', {
        path: { kind: threadKind, id: threadId },
        body: { lastReadSeq },
      });
    },
  };
}
