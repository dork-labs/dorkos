/**
 * Room Transport methods factory (HTTP adapter) — channels, DMs and threads
 * (spec `rooms`). Talks to the Express `/api/rooms/*` routes.
 *
 * Only the reads and the two writes the cockpit performs today are here.
 * Posting, the read cursor and thread creation reach the client in later phases
 * of the spec; the server already serves them, so they are a factory addition
 * and not a protocol change when they land.
 *
 * @module shared/lib/transport/room-methods
 */
import {
  RoomEventSchema,
  type AddRoomMemberRequest,
  type CreateRoomRequest,
  type ListRoomEntriesQuery,
  type ListRoomsQuery,
  type RoomEntry,
  type RoomEvent,
  type RoomMember,
  type RoomRosterEntry,
  type RoomSummary,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { fetchJSON, buildQueryString } from './http-client';
import { parseSSEStream } from './sse-parser';

/** Create the room methods bound to a base URL. */
export function createRoomMethods(baseUrl: string) {
  return {
    listRooms(query?: ListRoomsQuery): Promise<RoomSummary[]> {
      const qs = buildQueryString({
        kind: query?.kind,
        includeArchived: query?.includeArchived,
      });
      return fetchJSON<{ rooms: RoomSummary[] }>(baseUrl, `/rooms${qs}`).then((r) => r.rooms);
    },

    createRoom(req: CreateRoomRequest): Promise<RoomWithRoster> {
      return fetchJSON<RoomWithRoster>(baseUrl, '/rooms', {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    getRoom(id: string): Promise<RoomWithRoster> {
      return fetchJSON<RoomWithRoster>(baseUrl, `/rooms/${id}`);
    },

    listRoomEntries(id: string, query?: ListRoomEntriesQuery): Promise<RoomEntry[]> {
      const qs = buildQueryString({ before: query?.before, limit: query?.limit });
      return fetchJSON<{ entries: RoomEntry[] }>(baseUrl, `/rooms/${id}/entries${qs}`).then(
        (r) => r.entries
      );
    },

    addRoomMember(id: string, req: AddRoomMemberRequest): Promise<RoomRosterEntry> {
      return fetchJSON<RoomRosterEntry>(baseUrl, `/rooms/${id}/members`, {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    setRoomReadCursor(id: string, lastReadSeq: number): Promise<RoomMember> {
      return fetchJSON<RoomMember>(baseUrl, `/rooms/${id}/read-cursor`, {
        method: 'PUT',
        body: JSON.stringify({ lastReadSeq }),
      });
    },

    /**
     * Subscribe to a room's durable event stream.
     *
     * The leading `snapshot` frame of a cold connect is skipped: the room and
     * its history are hydrated through `getRoom` / `listRoomEntries`, so
     * re-parsing the snapshot here would only duplicate what the cache already
     * holds. Callers that already have entries pass the highest `seq` they hold
     * as `sinceCursor`, which the server replays from gap-free.
     *
     * Malformed frames are dropped with a warning rather than tearing the
     * stream down, matching the session stream's validation semantics.
     */
    async *subscribeRoom(
      roomId: string,
      sinceCursor?: number,
      signal?: AbortSignal
    ): AsyncIterable<RoomEvent> {
      const controller = new AbortController();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      const qs = buildQueryString({ after: sinceCursor });
      const response = await fetch(`${baseUrl}/rooms/${roomId}/events${qs}`, {
        headers: { Accept: 'text/event-stream' },
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        controller.abort();
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      try {
        for await (const frame of parseSSEStream(response.body.getReader())) {
          if (frame.comment || frame.type === 'snapshot') continue;
          const parsed = RoomEventSchema.safeParse(frame.data);
          if (!parsed.success) {
            console.warn('[Transport] dropping malformed room-event frame', {
              roomId,
              issues: parsed.error.issues,
            });
            continue;
          }
          yield parsed.data;
        }
      } finally {
        controller.abort();
      }
    },
  };
}
