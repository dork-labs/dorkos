/**
 * `GET /api/rooms/:id/events` over a WebSocket — what the cockpit uses.
 *
 * Same path, same durable contract, same sequencing as the SSE handler beside
 * it (`room-events-handler.ts`): both resolve a {@link RoomStreamPlan} and hand
 * it to {@link deliverRoomStream}. See `services/core/durable-stream-sink.ts`
 * for why both exist.
 *
 * @module routes/room-events-socket
 */
import { STREAM_RESUME_PARAM } from '@dorkos/shared/stream-socket';
import { getRoomService, RoomError } from '../services/rooms/index.js';
import { deliverRoomStream } from '../services/core/streams/room-stream-delivery.js';
import { resolveCaller } from './room-caller.js';
import { STATUS_BY_CODE } from './room-error-response.js';
import { DurableStreamSocket } from '../services/core/streams/stream-socket.js';
import type { UpgradeDecision, UpgradeRoute } from '../services/core/streams/upgrade-router.js';
import { parseResumeCursor } from '../lib/stream-cursor.js';
import { logger } from '../lib/logger.js';

/** Matches `/api/rooms/:id/events`, capturing the room id. */
const ROOM_EVENTS_PATH = /^\/api\/rooms\/([^/]+)\/events$/;

/** The upgrade route for a room's durable event stream. */
export const roomEventsRoute: UpgradeRoute = {
  name: 'room-events',
  pattern: ROOM_EVENTS_PATH,
  // The router runs the credential gate before this is called.
  credential: 'required',

  authorize({ url, headers, match, locals }): UpgradeDecision {
    const roomId = decodeURIComponent(match[1]!);

    // Refusals go out as a close frame rather than a failed handshake, because
    // a browser cannot read the status of a failed one — and this stream is
    // exactly where that distinction is load-bearing. The room hook retries a
    // transient failure forever but must stop when the server says the room is
    // gone, access was revoked, or the reader is signed out.
    const refuse = (status: number, message: string): UpgradeDecision => ({
      ok: false,
      status,
      message,
      deliver: 'close-frame',
    });

    let viewerAuthorId: string;
    let service: ReturnType<typeof getRoomService>;
    try {
      service = getRoomService();
      // The identity `sessionGate` and `resolveAgentIdentity` would have put on
      // `res.locals` was resolved by `authorizeStreamUpgrade` instead, because
      // neither middleware runs for an upgrade.
      viewerAuthorId = resolveCaller({ headers }, { locals }).id;
      // Refuse BEFORE any frame is sent. `getRoom` is membership-scoped, so this
      // refuses an unknown room and a room the caller is not in identically —
      // subscribing to somebody else's DM by id is the same leak as reading it.
      if (!service.getRoom(roomId, viewerAuthorId)) return refuse(404, 'No such room');
    } catch (err) {
      // Statused from the shared table rather than pinned to 404: a room the
      // caller may not see is 404, but an agent token the server could not
      // verify is 401 (DOR-1361). Both are already fatal to the client's retry
      // loop (`FATAL_STREAM_STATUSES` in `transport/room-methods.ts` holds 401,
      // 403 and 404 alike), so what this buys is not a stopped retry — it is
      // that the close frame names the right thing. "No such room" sent to a
      // revoked agent describes a room that is perfectly fine.
      if (err instanceof RoomError) return refuse(STATUS_BY_CODE[err.code], err.message);
      logger.warn('[ws room] room resolve failed', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
      return refuse(500, 'Internal Server Error');
    }

    // The room id is passed so a cursor minted for a DIFFERENT room is refused:
    // a room's seq space is per-room and durable, so another room's cursor is a
    // plausible number that would silently skip real entries here.
    const requested = parseResumeCursor(
      url.searchParams.get(STREAM_RESUME_PARAM) ?? undefined,
      url.searchParams.get('after') ?? undefined,
      { resourceId: roomId }
    );
    // Bound it to what the room actually has. An out-of-range cursor
    // (`?after=99999`) would otherwise set the live-dedupe watermark above every
    // seq this room will issue for the life of the connection, silently
    // suppressing every entry the reader is connected to receive. Past the end
    // is not a resume; it is a cold connect that hydrates from the snapshot.
    const maxSeq = service.maxSeq(roomId);
    const sinceCursor = requested !== undefined && requested <= maxSeq ? requested : undefined;

    return {
      ok: true,
      open: (ws) => {
        void deliverRoomStream(new DurableStreamSocket(ws), {
          roomId,
          viewerAuthorId,
          sinceCursor,
        });
      },
    };
  },
};
