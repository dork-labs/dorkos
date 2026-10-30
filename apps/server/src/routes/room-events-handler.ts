/**
 * `GET /api/rooms/:id/events` over Server-Sent Events.
 *
 * The SSE half of the durable room stream, kept as the public integration
 * contract alongside the WebSocket the app uses (`room-events-socket.ts`);
 * see `services/core/durable-stream-sink.ts` for why there are two. Both
 * resolve the same {@link RoomStreamPlan} and hand it to the same
 * {@link deliverRoomStream} — only the sink differs.
 *
 * The stream is written straight to the Node response
 * (`http/raw-node-stream.ts`), so the frames are the same bytes Express wrote.
 *
 * @module routes/room-events-handler
 */
import type { Context } from 'hono';
import { STREAM_RESUME_PARAM } from '@dorkos/shared/stream-socket';
import { UNOWNED_STREAM_GENERATION } from '@dorkos/shared/session-stream';
import { docScopeNotifications } from '../services/canvas/doc-channel/streams/registry.js';
import { getRoomService, RoomError } from '../services/rooms/index.js';
import {
  deliverRoomStream,
  type RoomStreamPlan,
} from '../services/core/streams/room-stream-delivery.js';
import { SseStreamSink } from '../services/core/streams/durable-stream-sink.js';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { errorBody } from '../lib/route-utils.js';
import { cursorMatchesGeneration, parseResumeCursor } from '../lib/stream-cursor.js';
import { resolveCaller } from './room-caller.js';
import { STATUS_BY_CODE } from './room-error-response.js';

/**
 * Hono handler for `GET /api/rooms/:id/events`.
 *
 * On a cold connect it emits the room, its roster and the trailing history as
 * one `snapshot` frame, then goes live from that snapshot's cursor. With a
 * `Last-Event-ID`/`?after=` resume signal it SKIPS the snapshot and replays
 * only entries above the cursor before going live.
 *
 * @param c - The Hono context.
 * @returns The refusal, or the marker for a stream already written.
 */
export async function roomEventsHandler(c: Context<ApiEnv>): Promise<Response> {
  const roomId = c.req.param('id')!;
  const facts = honoRequestFacts(c);

  let service: ReturnType<typeof getRoomService>;
  let viewerAuthorId: string;
  try {
    service = getRoomService();
    viewerAuthorId = resolveCaller(facts, 'read').id;
    // Fail BEFORE headers flush, so it is a plain 404 the client can read
    // rather than a socket that opens and immediately dies. `getRoom` is
    // membership-scoped, so this refuses an unknown room and a room the caller
    // is not in identically — subscribing to somebody else's DM by id is the
    // same leak as reading it.
    if (!service.getRoom(roomId, viewerAuthorId)) {
      return c.json(errorBody('No such room', 'ROOM_NOT_FOUND'), 404);
    }
  } catch (err) {
    // Statused from the shared table rather than pinned to 404, because the two
    // ways this can throw are not the same fact: a room the caller may not see
    // is 404 (and every `RoomError` `getRoom` can raise is one), while an agent
    // token the server could not verify is 401 (DOR-1361). Answered BEFORE
    // headers flush either way, so the client reads a status rather than a
    // socket that opens and dies. Anything else is the chain's error.
    if (err instanceof RoomError) {
      return c.json(errorBody(err.message, err.code), STATUS_BY_CODE[err.code] as 404);
    }
    throw err;
  }

  // The room id is passed so a cursor minted for a DIFFERENT room is refused:
  // a room's seq space is per-room and durable, so another room's cursor is a
  // plausible number that would silently skip real entries here.
  const query = readQuery(c);
  const requested = parseResumeCursor(
    (facts.headers['last-event-id'] as string | undefined) ??
      (query[STREAM_RESUME_PARAM] as string | undefined),
    query.after as string | undefined,
    { resourceId: roomId }
  );
  // Bound it to what the room actually has. An out-of-range cursor (`?after=99999`)
  // would otherwise set the live-dedupe watermark above every seq this room will
  // issue for the life of the connection, silently suppressing every entry the
  // reader is connected to receive. Past the end is not a resume; it is a cold
  // connect that hydrates from the snapshot.
  //
  // The generation is judged here rather than at the subscribe, because a room's
  // seq space cannot be swapped mid-request the way a session's projector can:
  // it is the durable log, and it is the same one a tick from now.
  const maxSeq = service.maxSeq(roomId);
  const sinceCursor =
    requested !== undefined &&
    cursorMatchesGeneration(requested, UNOWNED_STREAM_GENERATION) &&
    requested.seq <= maxSeq
      ? requested.seq
      : undefined;

  return streamToNodeResponse(c, async (res) => {
    const sink = new SseStreamSink(res);
    // A resume connect whose gap is empty writes nothing until the first live
    // entry; without this the client cannot tell "connected, nothing new" from
    // "still connecting". See SseStreamSink.flushHeaders.
    sink.flushHeaders();
    const plan: RoomStreamPlan = {
      roomId,
      viewerAuthorId,
      sinceCursor,
      documentNotifications: docScopeNotifications(`room:${roomId}`, facts),
    };
    await deliverRoomStream(sink, plan);
  });
}
