/**
 * The resume-cursor contract shared by every durable SSE stream this server
 * serves — `GET /api/sessions/:id/events` and `GET /api/rooms/:id/events`.
 *
 * Both frame their events as `id: <resourceId>-<epoch>-<seq>` and both accept
 * the client's echo of that id back as `Last-Event-ID`, so the parsing and the
 * epoch check live here once rather than once per stream.
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

/**
 * Parse the resume cursor from a durable `/events` request.
 *
 * Precedence: `Last-Event-ID` header (auto-sent by the browser EventSource and
 * the SSE client on reconnect) and the equivalent `?resume=` query a
 * WebSocket client sends both win over the plain `?after=` cursor.
 * The id frame format is `<resourceId>-<epoch>-<seq>`; the header resumes only
 * when its epoch matches this process's {@link STREAM_EPOCH} — an id minted by
 * a previous server process (or the legacy `<id>-<seq>` format) falls through
 * to a cold connect. `?after=` is the integer cursor directly (no epoch; it is
 * still validated against the stream's own replay window on subscribe).
 * Returns `undefined` for a cold connect.
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
): number | undefined {
  const epoch = opts.epoch ?? STREAM_EPOCH;
  if (lastEventId) {
    // Take the trailing `-<epoch>-<seq>` so resource ids that contain hyphens
    // (session UUIDs) don't break the split — only the final two segments are
    // ours.
    const match = /-(\d+)-(\d+)$/.exec(lastEventId);
    if (opts.resourceId !== undefined && !lastEventId.startsWith(`${opts.resourceId}-`)) {
      // A cursor minted for a different resource: cold connect, never resume.
      return undefined;
    }
    if (match && Number(match[1]) === epoch) return Number(match[2]);
    // Mismatched or absent epoch: the cursor belongs to another seq space —
    // treat as cold rather than resuming into the wrong stream.
    return undefined;
  }
  if (after !== undefined && after !== '') {
    const cursor = Number(after);
    if (Number.isInteger(cursor) && cursor >= 0) return cursor;
  }
  return undefined;
}
