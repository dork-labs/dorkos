/**
 * A strict server-sent events parser for the managed remote access command
 * stream (DOR-2086), following the WHATWG event-stream interpretation rules
 * and nothing looser.
 *
 * - Lines end in CRLF, LF or a lone CR, and a CRLF split across two chunks is
 *   still one line ending.
 * - A line starting with `:` is a comment (servers send them as heartbeats).
 * - `data` lines accumulate, joined with LF; `event`, `id` and `retry` set
 *   their field; an unknown field is ignored, as the standard says.
 * - `retry` counts only when it is all ASCII digits.
 * - A blank line dispatches the event, and only when it carried data.
 * - One leading byte-order mark is dropped.
 *
 * It has a size bound: an event whose buffered lines pass
 * {@link SSE_MAX_EVENT_BYTES} is a protocol violation ({@link SseOverflowError}),
 * so a misbehaving peer cannot grow this process's memory without limit.
 *
 * @module services/core/remote/sse-parser
 */

/** The largest one event may grow to, in UTF-16 code units, before the stream is refused. */
export const SSE_MAX_EVENT_BYTES = 64 * 1024;

/** One dispatched event. */
export interface SseEvent {
  /** The `event` field, or `message` when none was sent. */
  event: string;
  /** Every `data` line, joined with LF. */
  data: string;
  /** The last `id` field seen, or `undefined`. */
  id: string | undefined;
}

/** Raised by {@link SseParser.feed} when one event grows past the size bound. */
export class SseOverflowError extends Error {
  constructor() {
    super('A server-sent event was larger than this computer accepts.');
    this.name = 'SseOverflowError';
  }
}

/** Incremental parser: feed decoded text in, take whole events out. */
export class SseParser {
  private buffer = '';
  private atStart = true;
  /** The previous chunk ended in CR, so a leading LF here ends nothing. */
  private skipLeadingLf = false;
  private eventType = '';
  private data: string[] = [];
  private dataSize = 0;
  private lastId: string | undefined;
  /** The latest valid `retry` value, in milliseconds, or `undefined`. */
  retryMs: number | undefined;

  /**
   * Feed one chunk of decoded text.
   *
   * @param chunk - Text exactly as it arrived; may split lines anywhere.
   * @returns The events this chunk completed, in order.
   * @throws {SseOverflowError} When an event outgrows {@link SSE_MAX_EVENT_BYTES}.
   */
  feed(chunk: string): SseEvent[] {
    let text = chunk;
    if (this.atStart && text.length > 0) {
      this.atStart = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.skipLeadingLf && text.startsWith('\n')) text = text.slice(1);
    this.skipLeadingLf = false;
    this.buffer += text;

    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const code = this.buffer.charCodeAt(i);
      if (code !== 0x0a && code !== 0x0d) continue;
      const line = this.buffer.slice(start, i);
      if (code === 0x0d) {
        if (i + 1 < this.buffer.length) {
          if (this.buffer.charCodeAt(i + 1) === 0x0a) i += 1;
        } else {
          this.skipLeadingLf = true;
        }
      }
      start = i + 1;
      const event = this.line(line);
      if (event) events.push(event);
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length + this.dataSize > SSE_MAX_EVENT_BYTES) throw new SseOverflowError();
    return events;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.data.push(value);
        this.dataSize += value.length + 1;
        if (this.dataSize > SSE_MAX_EVENT_BYTES) throw new SseOverflowError();
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastId = value;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break;
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    const hadData = this.data.length > 0;
    const event: SseEvent = {
      event: this.eventType === '' ? 'message' : this.eventType,
      data: this.data.join('\n'),
      id: this.lastId,
    };
    this.eventType = '';
    this.data = [];
    this.dataSize = 0;
    return hadData ? event : null;
  }
}
