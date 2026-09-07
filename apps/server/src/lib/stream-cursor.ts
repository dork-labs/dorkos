/**
 * The resume-cursor contract shared by every durable SSE stream this server
 * serves — `GET /api/sessions/:id/events` and `GET /api/rooms/:id/events`.
 *
 * Both frame their events as `id: <resourceId>-<epoch>-<generation>-<seq>` and
 * both accept the client's echo of that id back as `Last-Event-ID`, so the
 * parsing and the two seq-space checks live here once rather than once per
 * stream.
 *
 * @module lib/stream-cursor
 */

/**
 * Identifies this server process's seq space in every `id:` frame.
 *
 * A session's `seq` counter lives in an in-process projector and restarts from
 * 0 with the process, so a cursor minted by a PREVIOUS process is meaningless
 * in this one — comparing bare integers across a restart can silently validate
 * (client cursor ≤ new counter) and then replay the wrong events. The
 * client echoes the whole id back (as `Last-Event-ID` over SSE, as `?resume=`
 * over a socket), so a
 * mismatched epoch routes the reconnect to the cold snapshot path instead of a
 * bogus resume.
 *
 * A room's `seq` is durable and per-room, so a room cursor would in fact
 * survive a restart. It carries the epoch anyway: one frame format across both
 * streams is worth more than saving a room reader one snapshot after a server
 * restart, and a client that had to know which streams keep their seq space
 * would be a client that gets it wrong.
 */
export const STREAM_EPOCH = Date.now();

/** A resume signal parsed off a durable `/events` request. */
export interface ResumeCursor {
  /** Replay events whose `seq` is strictly greater than this. */
  seq: number;
  /**
   * The seq space this cursor was minted in, or `null` when it came from a bare
   * `?after=` integer — which names no seq space at all and is therefore
   * checked only against the stream's own replay window.
   */
  generation: string | null;
}

/**
 * Frame id shape: `<resourceId>-<epoch>-<generation>-<seq>`.
 *
 * Only the trailing three segments are read, so resource ids that contain
 * hyphens (session UUIDs) don't break the split. The generation's `g` prefix is
 * what makes a PRE-generation id — the three-segment `<resourceId>-<epoch>-<seq>`
 * this server used to write — fail to match rather than misparse: a tab held
 * open across the deploy comes back with one of those, and it must read as
 * "names no seq space I can serve", never as a plausible number.
 */
const FRAME_ID = /-(\d+)-(g\d+)-(\d+)$/;

/**
 * Parse the resume cursor from a durable `/events` request.
 *
 * Precedence: `Last-Event-ID` header (auto-sent by the browser EventSource and
 * the SSE client on reconnect) and the equivalent `?resume=` query a
 * WebSocket client sends both win over the plain `?after=` cursor.
 * The header resumes only when its epoch matches this process's
 * {@link STREAM_EPOCH} — an id minted by a previous server process, or in the
 * pre-generation format, falls through to a cold connect. `?after=` is the
 * integer cursor directly (no epoch, no generation; it is still validated
 * against the stream's own replay window on subscribe).
 * Returns `undefined` for a cold connect.
 *
 * The GENERATION is parsed but not judged here, because this function cannot
 * know which seq space is about to serve the request: for a session that answer
 * belongs to the projector registry and is only stable in the same tick as the
 * subscribe. Callers compare it with {@link cursorMatchesGeneration}.
 *
 * When `resourceId` is given, the header must also name THAT resource. A
 * session's `seq` is per-process so a foreign cursor is usually caught by the
 * epoch, but a room's `seq` is per-room and durable: room A's cursor replayed
 * against room B has a plausible-looking number that would silently skip real
 * entries. Callers with a per-resource seq space should always pass it.
 *
 * @param lastEventId - The `Last-Event-ID` request header, if any.
 * @param after - The `?after=` query param, if any.
 * @param opts.epoch - This process's stream epoch (injectable for tests).
 * @param opts.resourceId - Require the cursor to belong to this resource.
 */
export function parseResumeCursor(
  lastEventId: string | undefined,
  after: string | undefined,
  opts: { epoch?: number; resourceId?: string } = {}
): ResumeCursor | undefined {
  const epoch = opts.epoch ?? STREAM_EPOCH;
  if (lastEventId) {
    if (opts.resourceId !== undefined && !lastEventId.startsWith(`${opts.resourceId}-`)) {
      // A cursor minted for a different resource: cold connect, never resume.
      return undefined;
    }
    const match = FRAME_ID.exec(lastEventId);
    // Mismatched or absent epoch, or an id this server never wrote: the cursor
    // belongs to another seq space — treat as cold rather than resuming into
    // the wrong stream.
    if (!match || Number(match[1]) !== epoch) return undefined;
    return { seq: Number(match[3]), generation: match[2] as string };
  }
  if (after !== undefined && after !== '') {
    const seq = Number(after);
    if (Number.isInteger(seq) && seq >= 0) return { seq, generation: null };
  }
  return undefined;
}

/**
 * Whether a parsed cursor may be resumed against the seq space now serving.
 *
 * A `null` generation is the `?after=` escape hatch and passes: that cursor
 * never claimed a seq space, so the stream's own window check is the whole
 * contract for it. Anything else must name the serving space exactly — a
 * mismatch is a cursor from a retired counter, and the only safe answer is a
 * fresh snapshot.
 *
 * The escape hatch is narrow rather than lax. Its only in-repo consumer is
 * `HttpTransport.subscribeSession` (`transport/session-stream-methods.ts`),
 * which passes the cursor of a snapshot it has just taken in the same call — so
 * the number cannot predate the counter answering it. A third-party client that
 * PERSISTS an `?after=` integer across a reconnect gets no generation check and
 * only the replay window between it and a wrong replay, which is why the
 * documented cursor is the whole frame id.
 *
 * @param cursor - What {@link parseResumeCursor} returned.
 * @param generation - The generation of the seq space about to serve, read in
 *   the SAME tick as the subscribe it guards.
 */
export function cursorMatchesGeneration(cursor: ResumeCursor, generation: string): boolean {
  return cursor.generation === null || cursor.generation === generation;
}

/**
 * Build the `id:` line for one frame.
 *
 * One writer for both streams, so the shape a reader echoes back is the shape
 * {@link parseResumeCursor} reads.
 *
 * @param resourceId - The session or room the frame belongs to.
 * @param generation - The generation of the seq space that stamped it.
 * @param seq - The event's sequence number within that space.
 */
export function streamFrameId(resourceId: string, generation: string, seq: number): string {
  return `${resourceId}-${STREAM_EPOCH}-${generation}-${seq}`;
}
