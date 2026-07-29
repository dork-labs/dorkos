/**
 * Room Transport methods factory (HTTP adapter) — channels and DMs (spec
 * `rooms`). Talks to the Express `/api/rooms/*` routes.
 *
 * Only what the cockpit performs today is here: reading a room, posting to it,
 * settling its title / topic / archived flag, editing its roster, and moving
 * the read cursor. Posting a thread reply is `POST /api/rooms/:id/threads` and
 * reaches this factory when the cockpit grows an affordance for it; nothing has
 * to be created first, since a thread is a relation between entries
 * (ADR 260728-022013), so it is a factory addition and not a protocol change.
 *
 * @module shared/lib/transport/room-methods
 */
import {
  RoomEventSchema,
  type AddRoomMemberRequest,
  type CreateRoomRequest,
  type ListRoomEntriesQuery,
  type ListRoomsQuery,
  type PostToRoomRequest,
  type PostToRoomResponse,
  type RoomEntry,
  type RoomEvent,
  type RoomMember,
  type RoomRosterEntry,
  type RoomSummary,
  type RoomWithRoster,
  type UpdateMembershipRequest,
  type UpdateRoomRequest,
} from '@dorkos/shared/room-schemas';
import { SSE_RESILIENCE } from '../constants';
import { fetchJSON, fetchNoContent, buildQueryString } from './http-client';
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

    updateRoom(id: string, req: UpdateRoomRequest): Promise<RoomWithRoster> {
      return fetchJSON<RoomWithRoster>(baseUrl, `/rooms/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(req),
      });
    },

    listRoomEntries(id: string, query?: ListRoomEntriesQuery): Promise<RoomEntry[]> {
      const qs = buildQueryString({ before: query?.before, limit: query?.limit });
      return fetchJSON<{ entries: RoomEntry[] }>(baseUrl, `/rooms/${id}/entries${qs}`).then(
        (r) => r.entries
      );
    },

    /**
     * Post to a room. The 202 answers with the entry's identity only — the
     * entry itself arrives on `subscribeRoom`, so nothing here writes it into
     * the cache.
     */
    postToRoom(id: string, req: PostToRoomRequest): Promise<PostToRoomResponse> {
      return fetchJSON<PostToRoomResponse>(baseUrl, `/rooms/${id}/entries`, {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    addRoomMember(id: string, req: AddRoomMemberRequest): Promise<RoomRosterEntry> {
      return fetchJSON<RoomRosterEntry>(baseUrl, `/rooms/${id}/members`, {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    updateRoomMember(
      id: string,
      authorId: string,
      req: UpdateMembershipRequest
    ): Promise<RoomRosterEntry> {
      return fetchJSON<RoomRosterEntry>(
        baseUrl,
        `/rooms/${id}/members/${encodeURIComponent(authorId)}`,
        { method: 'PATCH', body: JSON.stringify(req) }
      );
    },

    /** The route answers 204, so there is no body to read back. */
    removeRoomMember(id: string, authorId: string): Promise<void> {
      return fetchNoContent(baseUrl, `/rooms/${id}/members/${encodeURIComponent(authorId)}`, {
        method: 'DELETE',
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
     *
     * A silence watchdog runs here rather than in the consuming hook, and it is
     * the one piece of resilience that has to. The server heartbeats with an
     * SSE COMMENT (`: keepalive`), and comments are dropped a few lines below —
     * so above this seam "the socket is dead" and "the room is quiet" look
     * identical, and rooms are quiet nearly all the time. Down here the
     * heartbeat is visible: any frame at all resets the timer, and silence past
     * {@link SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS} (3x the server's interval)
     * aborts the connection so the iterable throws. That is what a half-open
     * socket — a slept laptop's — produces instead of an error, and the caller's
     * retry loop already knows what to do with a throw.
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

      let wentSilent = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      /** Restart the silence countdown. Called for every frame, comments too. */
      const heard = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          wentSilent = true;
          controller.abort();
        }, SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS);
      };

      try {
        // Armed before the fetch: a connect that hangs without answering is as
        // dead as one that stops mid-stream, and this call has no other timeout.
        heard();
        const qs = buildQueryString({ after: sinceCursor });
        const response = await fetch(`${baseUrl}/rooms/${roomId}/events${qs}`, {
          headers: { Accept: 'text/event-stream' },
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        for await (const frame of parseSSEStream(response.body.getReader())) {
          heard();
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
      } catch (err) {
        // The abort the watchdog fired surfaces as a generic AbortError, which
        // reads in a log like a caller who simply left. Say what happened.
        if (wentSilent) {
          throw new Error(
            `Room stream heard nothing for ${SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS}ms — treating it as dropped`
          );
        }
        throw err;
      } finally {
        clearTimeout(watchdog);
        controller.abort();
      }
    },
  };
}
