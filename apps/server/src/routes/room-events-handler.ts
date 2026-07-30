/**
 * The durable room-event SSE handler for `GET /api/rooms/:id/events`.
 *
 * Same three-part contract as the session stream (`session-events-handler.ts`):
 * snapshot on a cold connect, gap-free replay from `Last-Event-ID`, then live.
 * Extracted from `rooms.ts` so that route file stays under the file-size rule
 * (`.claude/rules/file-size.md`).
 *
 * One thing is easier here than it is for sessions, and it is worth naming: a
 * room's log is durable and never trimmed, so replay always reads from SQLite
 * and can always be served. There is no "replay window trimmed past your
 * cursor" fallback, because there is no window — an unservable cursor can only
 * come from a stale epoch, which {@link parseResumeCursor} already rejects.
 *
 * @module routes/room-events-handler
 */
import { once } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import type { RoomEntry, RoomEvent } from '@dorkos/shared/room-schemas';
import { getRoomService, RoomError } from '../services/rooms/index.js';
import { resolveCaller } from './room-caller.js';
import { initSSEStream, endSSEStream } from '../services/core/stream-adapter.js';
import { sendError } from '../lib/route-utils.js';
import { STREAM_EPOCH, parseResumeCursor } from '../lib/stream-cursor.js';
import { logger } from '../lib/logger.js';
import { SSE, ROOMS } from '../config/constants.js';

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
    viewerAuthorId = resolveCaller(res).id;
    // Fail BEFORE headers flush, so it is a plain 404 the client can read
    // rather than a socket that opens and immediately dies. `getRoom` is
    // membership-scoped, so this refuses an unknown room and a room the caller
    // is not in identically — subscribing to somebody else's DM by id is the
    // same leak as reading it.
    if (!service.getRoom(roomId, viewerAuthorId)) {
      return sendError(res, 404, 'No such room', 'ROOM_NOT_FOUND');
    }
  } catch (err) {
    if (err instanceof RoomError) return sendError(res, 404, err.message, err.code);
    return next(err);
  }

  // The room id is passed so a cursor minted for a DIFFERENT room is refused:
  // a room's seq space is per-room and durable, so another room's cursor is a
  // plausible number that would silently skip real entries here.
  const requested = parseResumeCursor(
    req.headers['last-event-id'] as string | undefined,
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

  initSSEStream(res);
  // Flush the headers immediately with an SSE comment. A resume connect whose
  // gap is empty writes nothing else until the first live entry, and without
  // this the client cannot tell "connected, nothing new" from "still
  // connecting" — Node holds `writeHead` until the first body write. Comment
  // lines are ignored by EventSource, so this costs the client nothing.
  res.write(': connected\n\n');

  const abortController = new AbortController();
  let closed = false;

  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, SSE.HEARTBEAT_INTERVAL_MS);

  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    abortController.abort();
  });

  /**
   * Write one framed event. Entries carry an `id:` line so the browser echoes
   * it back on reconnect; the snapshot, ephemeral signals and reaction updates
   * deliberately do not, so a reconnect resumes from the last durable entry
   * either way.
   *
   * A reaction is durable state and still gets no `id:` line, which is worth
   * being exact about because it looks like an omission. The cursor is the
   * highest ENTRY this reader holds; reactions have no place in that sequence
   * and inventing one would put two numbers in one header. What keeps them
   * correct across a gap is that each reaction event carries the entry's WHOLE
   * current set, plus the resync below — see {@link RoomReactionEventSchema}.
   *
   * Backpressure: when `write()` returns false the frame is buffered in process
   * memory, and awaiting `drain` before the next event bounds that buffer for a
   * slow consumer. Gap-free delivery is preserved — the send loop pauses, it
   * never skips a frame.
   */
  const send = async (event: RoomEvent): Promise<void> => {
    if (event.type === 'entry') res.write(`id: ${roomId}-${STREAM_EPOCH}-${event.seq}\n`);
    const flushed = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (!flushed) await once(res, 'drain', { signal: abortController.signal });
  };

  /** Frame one durable entry the same way a live one is framed. */
  const sendEntry = (entry: RoomEntry): Promise<void> =>
    send({ type: 'entry', seq: entry.seq, entry });

  // Subscribe FIRST, synchronously: anything committed between here and the
  // read below lands in this reader's queue instead of falling between the two.
  // The dedupe on `highestSent` then drops whatever the read already covered.
  const iterator = service.stream.subscribe(roomId, abortController.signal)[Symbol.asyncIterator]();

  let highestSent = 0;

  try {
    if (sinceCursor !== undefined) {
      // RESUME: skip the snapshot, replay the gap. The log is durable, so this
      // is always servable — there is no trimmed-window fallback to take.
      highestSent = sinceCursor;
      for (const entry of service.entriesAfter(roomId, sinceCursor)) {
        if (closed) return;
        await sendEntry(entry);
        highestSent = entry.seq;
      }
      // The replay's own entries arrive with their reactions attached. What it
      // cannot carry is a reaction that CHANGED on an older message while this
      // reader was away: that entry is below the cursor, so nothing replays it.
      // So the trailing window is resynced once, as state rather than as a
      // delta, and AFTER the replay — an entry the resync names is either one
      // just delivered above or one the reader was already holding.
      //
      // It reports EVERY entry in that window, empty sets included, and the
      // empties are the headline reason it exists rather than padding: a
      // REMOVAL leaves an entry unchanged AND holding no pills, so a resync
      // that only named entries still carrying some would say nothing about it
      // and leave this reader showing a reaction the server no longer has. The
      // empty frame is the only correction on the wire. `RoomService.reactionResync`
      // is the authoritative statement of this; keep the two in step.
      for (const event of service.reactionResync(roomId, ROOMS.SNAPSHOT_HISTORY_LIMIT)) {
        if (closed) return;
        await send(event);
      }
    } else {
      const snapshot = service.snapshot(roomId, viewerAuthorId, ROOMS.SNAPSHOT_HISTORY_LIMIT);
      if (closed) return;
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      highestSent = snapshot.cursor;
    }

    for (;;) {
      const { value, done } = await iterator.next();
      if (done || closed) break;
      if (value.type === 'entry') {
        if (value.seq <= highestSent) continue;
        highestSent = value.seq;
      }
      await send(value);
    }
  } catch (err) {
    if (!closed) {
      logger.warn('[GET /api/rooms/:id/events] room stream error', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearInterval(heartbeat);
    abortController.abort();
    void iterator.return?.();
    if (!closed) endSSEStream(res);
  }
};
