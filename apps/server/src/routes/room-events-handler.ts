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
  try {
    service = getRoomService();
    // Fail the unknown room BEFORE headers flush, so it is a plain 404 the
    // client can read rather than a socket that opens and immediately dies.
    if (!service.getRoom(roomId)) {
      return sendError(res, 404, 'No such room', 'ROOM_NOT_FOUND');
    }
  } catch (err) {
    if (err instanceof RoomError) return sendError(res, 404, err.message, err.code);
    return next(err);
  }

  const sinceCursor = parseResumeCursor(
    req.headers['last-event-id'] as string | undefined,
    req.query.after as string | undefined
  );

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
   * it back on reconnect; the snapshot and ephemeral signals deliberately do
   * not, so a reconnect resumes from the last durable entry either way.
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
    } else {
      const snapshot = service.snapshot(roomId, ROOMS.SNAPSHOT_HISTORY_LIMIT);
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
