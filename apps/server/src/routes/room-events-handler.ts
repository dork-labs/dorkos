/**
 * `GET /api/rooms/:id/events` over Server-Sent Events.
 *
 * The SSE half of the durable room stream, kept as the public integration
 * contract alongside the WebSocket the cockpit uses (`room-events-socket.ts`);
 * see `services/core/durable-stream-sink.ts` for why there are two. Both
 * resolve the same {@link RoomStreamPlan} and hand it to the same
 * {@link deliverRoomStream} — only the sink differs.
 *
 * @module routes/room-events-handler
 */
import type { NextFunction, Request, Response } from 'express';
import { STREAM_RESUME_PARAM } from '@dorkos/shared/stream-socket';
import { getRoomService, RoomError } from '../services/rooms/index.js';
import { deliverRoomStream } from '../services/core/streams/room-stream-delivery.js';
import { resolveCaller } from './room-caller.js';
import { STATUS_BY_CODE } from './room-error-response.js';
import { SseStreamSink } from '../services/core/streams/durable-stream-sink.js';
import { sendError } from '../lib/route-utils.js';
import { parseResumeCursor } from '../lib/stream-cursor.js';

/** Route params for `GET /:id/events` — pins `id` to `string` for the handler. */
interface RoomEventsParams {
  id: string;
}

/**
 * Express handler for `GET /api/rooms/:id/events`.
 *
 * On a cold connect it emits the room, its roster and the trailing history as
 * one `snapshot` frame, then goes live from that snapshot's cursor. With a
 * `Last-Event-ID`/`?after=` resume signal it SKIPS the snapshot and replays
 * only entries above the cursor before going live.
 */
export const roomEventsHandler = async (
  req: Request<RoomEventsParams>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const roomId = req.params.id;

  let service: ReturnType<typeof getRoomService>;
  let viewerAuthorId: string;
  try {
    service = getRoomService();
    viewerAuthorId = resolveCaller(req, res).id;
    // Fail BEFORE headers flush, so it is a plain 404 the client can read
    // rather than a socket that opens and immediately dies. `getRoom` is
    // membership-scoped, so this refuses an unknown room and a room the caller
    // is not in identically — subscribing to somebody else's DM by id is the
    // same leak as reading it.
    if (!service.getRoom(roomId, viewerAuthorId)) {
      return sendError(res, 404, 'No such room', 'ROOM_NOT_FOUND');
    }
  } catch (err) {
    // Statused from the shared table rather than pinned to 404, because the two
    // ways this can throw are not the same fact: a room the caller may not see
    // is 404 (and every `RoomError` `getRoom` can raise is one), while an agent
    // token the server could not verify is 401 (DOR-1361). Answered BEFORE
    // headers flush either way, so the client reads a status rather than a
    // socket that opens and dies.
    if (err instanceof RoomError) {
      return sendError(res, STATUS_BY_CODE[err.code], err.message, err.code);
    }
    return next(err);
  }

  // The room id is passed so a cursor minted for a DIFFERENT room is refused:
  // a room's seq space is per-room and durable, so another room's cursor is a
  // plausible number that would silently skip real entries here.
  const requested = parseResumeCursor(
    (req.headers['last-event-id'] as string | undefined) ??
      (req.query[STREAM_RESUME_PARAM] as string | undefined),
    req.query.after as string | undefined,
    { resourceId: roomId }
  );
  // Bound it to what the room actually has. An out-of-range cursor (`?after=99999`)
  // would otherwise set the live-dedupe watermark above every seq this room will
  // issue for the life of the connection, silently suppressing every entry the
  // reader is connected to receive. Past the end is not a resume; it is a cold
  // connect that hydrates from the snapshot.
  const maxSeq = service.maxSeq(roomId);
  const sinceCursor = requested !== undefined && requested <= maxSeq ? requested : undefined;

  const sink = new SseStreamSink(res);
  // A resume connect whose gap is empty writes nothing until the first live
  // entry; without this the client cannot tell "connected, nothing new" from
  // "still connecting". See SseStreamSink.flushHeaders.
  sink.flushHeaders();

  await deliverRoomStream(sink, { roomId, viewerAuthorId, sinceCursor });
};
