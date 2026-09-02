/**
 * The durable room stream's sequencing — snapshot → gap-free replay → live —
 * written once for both protocols it is served over.
 *
 * Same three-part contract as the session stream, and the same reason for
 * living apart from its handlers: `routes/room-events-handler.ts` (SSE, the
 * public integration contract) and `routes/room-events-socket.ts` (WebSocket,
 * what the cockpit uses) both resolve a plan and hand it here with their own
 * {@link DurableStreamSink}.
 *
 * One thing is easier here than it is for sessions, and it is worth naming: a
 * room's log is durable and never trimmed, so replay always reads from SQLite
 * and can always be served. There is no "replay window trimmed past your
 * cursor" fallback, because there is no window — an unservable cursor can only
 * come from a stale epoch, which `parseResumeCursor` already rejects.
 *
 * @module services/core/streams/room-stream-delivery
 */
import type { RoomEntry, RoomEvent } from '@dorkos/shared/room-schemas';
import type { DurableStreamSink } from './durable-stream-sink.js';
import { getRoomService } from '../../rooms/index.js';
import { STREAM_EPOCH } from '../../../lib/stream-cursor.js';
import { logger } from '../../../lib/logger.js';
import { ROOMS } from '../../../config/constants.js';

/** Everything a caller must resolve before a room stream can be delivered. */
export interface RoomStreamPlan {
  /** The room being streamed. */
  roomId: string;
  /** The author id the snapshot is scoped to (membership, unread cursor). */
  viewerAuthorId: string;
  /** The resume cursor, or `undefined` for a cold connect. */
  sinceCursor: number | undefined;
}

/**
 * Deliver one room stream to completion.
 *
 * Never throws: a mid-stream failure is logged and closes the stream, which the
 * client's retry loop handles.
 *
 * @param sink - Where frames go and how a departing reader is noticed.
 * @param plan - What the caller resolved.
 */
export async function deliverRoomStream(
  sink: DurableStreamSink,
  plan: RoomStreamPlan
): Promise<void> {
  const { roomId, viewerAuthorId, sinceCursor } = plan;
  const service = getRoomService();

  /**
   * Write one framed event. Entries carry a frame id so a reader can resume
   * from them; the snapshot, ephemeral signals and reaction updates
   * deliberately do not, so a reconnect resumes from the last durable entry
   * either way.
   *
   * A reaction is durable state and still gets no id, which is worth being
   * exact about because it looks like an omission. The cursor is the highest
   * ENTRY this reader holds; reactions have no place in that sequence and
   * inventing one would put two numbers in one cursor. What keeps them correct
   * across a gap is that each reaction event carries the entry's WHOLE current
   * set, plus the resync below.
   */
  const send = (event: RoomEvent): Promise<void> =>
    sink.send({
      event: event.type,
      data: event,
      ...(event.type === 'entry' ? { id: `${roomId}-${STREAM_EPOCH}-${event.seq}` } : {}),
    });

  /** Frame one durable entry the same way a live one is framed. */
  const sendEntry = (entry: RoomEntry): Promise<void> =>
    send({ type: 'entry', seq: entry.seq, entry });

  // Subscribe FIRST, synchronously: anything committed between here and the
  // read below lands in this reader's queue instead of falling between the two.
  // The dedupe on `highestSent` then drops whatever the read already covered.
  const iterator = service.stream.subscribe(roomId, sink.signal)[Symbol.asyncIterator]();

  let highestSent: number;

  try {
    if (sinceCursor !== undefined) {
      highestSent = sinceCursor;
      for (const entry of service.entriesAfter(roomId, sinceCursor)) {
        if (sink.closed) return;
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
        if (sink.closed) return;
        await send(event);
      }
    } else {
      const snapshot = service.snapshot(roomId, viewerAuthorId, ROOMS.SNAPSHOT_HISTORY_LIMIT);
      if (sink.closed) return;
      await sink.send({ event: 'snapshot', data: snapshot });
      highestSent = snapshot.cursor;
    }

    for (;;) {
      const { value, done } = await iterator.next();
      if (done || sink.closed) break;
      if (value.type === 'entry') {
        if (value.seq <= highestSent) continue;
        highestSent = value.seq;
      }
      await send(value);
    }
  } catch (err) {
    if (!sink.closed) {
      logger.warn('[room stream] error', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    void iterator.return?.();
    sink.end();
  }
}
