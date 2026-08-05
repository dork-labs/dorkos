/**
 * The wire contract for DorkOS's durable event streams (ADR 260804-030000).
 *
 * All three durable streams — a session's events, the global broadcast stream,
 * and a room's events — ride WebSockets rather than Server-Sent Events. The
 * reason is a browser limit, not a protocol preference: HTTP/1.1 allows about
 * six sockets per origin **per browser profile**, and an SSE stream holds one
 * for as long as it is open. Three cockpit windows park six streams between
 * them and every subsequent request to that origin — including the next
 * window's own HTML — queues behind them forever. WebSockets are exempt from
 * that pool (Chromium allows ~255 per host), so moving the durable streams onto
 * them removes the ceiling instead of raising it.
 *
 * The frame shape deliberately mirrors what SSE carried, field for field, so
 * the durable contract above it is untouched: `event` is the SSE `event:` name,
 * `data` the parsed `data:` payload, and `id` the `id:` line the client echoes
 * back to resume. What changes is only how the bytes arrive.
 *
 * @module stream-socket
 */

/**
 * Query parameter carrying the resume cursor a reconnecting client holds.
 *
 * SSE sent this as the `Last-Event-ID` **header**, which a browser
 * `WebSocket` cannot set — the constructor takes a URL and subprotocols and
 * nothing else. The cursor therefore moves into the URL, where the server's
 * existing {@link parseResumeCursor} reads it exactly as it read the header:
 * the value is the whole `<resourceId>-<epoch>-<seq>` frame id, NOT a bare
 * seq, so the epoch check that rejects a cursor minted by a previous server
 * process survives the move intact. Sending a bare seq here would silently
 * lose that check and let a restarted server replay the wrong events.
 */
export const STREAM_RESUME_PARAM = 'resume';

/**
 * Event name of the server's liveness frame.
 *
 * SSE heartbeats were comment lines (`: keepalive`), which the protocol lets a
 * parser drop without involving the application. A WebSocket has no comment, and
 * its protocol-level ping/pong is invisible to browser JavaScript — a page
 * cannot observe that a pong arrived, so it cannot use one as proof of life.
 * So liveness is an ordinary frame with a reserved name: it resets the client's
 * silence watchdog like any other frame and is then dropped before dispatch,
 * which is why the name is namespaced out of the way of every real event.
 */
export const STREAM_HEARTBEAT_EVENT = '__heartbeat';

/**
 * Offset that turns an HTTP status into a WebSocket close code.
 *
 * A browser cannot read the HTTP status of a FAILED WebSocket handshake — the
 * `WebSocket` API surfaces no response, and `close` reports the generic `1006`.
 * That would have silently cost the room stream a shipped behaviour: it retries
 * a transient failure forever but stops on 401/403/404, because "reconnecting…"
 * drawn over a room that was deleted is a worse lie than the freeze the infinite
 * retry fixed.
 *
 * So a durable stream refuses by COMPLETING the handshake and immediately
 * closing with `4000 + status`, which both a browser and a Node client can read.
 * The 4000–4999 range is reserved by RFC 6455 for exactly this. Non-durable
 * upgrades (the terminal) still refuse at the handshake, where an HTTP status is
 * the better answer and no client needs to tell the reasons apart.
 */
export const STREAM_CLOSE_CODE_BASE = 4000;

/**
 * Recover the HTTP status a stream socket was refused with, or `null` when the
 * close was not an application refusal (a normal close, or a dropped socket).
 *
 * @param code - The WebSocket close code.
 */
export function statusFromCloseCode(code: number): number | null {
  const status = code - STREAM_CLOSE_CODE_BASE;
  return status >= 100 && status < 600 ? status : null;
}

/** One frame on a durable stream socket — the SSE triple, JSON-encoded. */
export interface StreamFrame {
  /** The event name, e.g. `text_delta`, `snapshot`, `room_created`. */
  event: string;
  /** The event payload. Absent for {@link STREAM_HEARTBEAT_EVENT}. */
  data?: unknown;
  /**
   * The resume cursor this frame advances the client to, as
   * `<resourceId>-<epoch>-<seq>`. Present only on frames that occupy a place in
   * the sequence — a snapshot and an ephemeral signal carry none, exactly as
   * they carried no `id:` line over SSE.
   */
  id?: string;
}

/**
 * Serialize one frame for the wire.
 *
 * Callers that fan one frame out to many sockets should call this ONCE and send
 * the result to each, which is what the global broadcaster does.
 *
 * @param frame - The frame to encode.
 */
export function encodeStreamFrame(frame: StreamFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse one frame off the wire, or `null` when it is not a well-formed frame.
 *
 * Fails soft rather than throwing: a malformed frame is a dropped frame, never
 * a torn-down stream. A stream that died on one bad payload would take the
 * whole window's live state with it.
 *
 * @param raw - The raw text frame received from the socket.
 */
export function decodeStreamFrame(raw: string): StreamFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.event !== 'string') return null;
  return {
    event: candidate.event,
    ...('data' in candidate ? { data: candidate.data } : {}),
    ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
  };
}
