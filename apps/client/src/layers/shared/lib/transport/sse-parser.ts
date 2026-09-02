/**
 * Reusable SSE stream parser for the Transport layer.
 *
 * Implements the full SSE spec (https://html.spec.whatwg.org/multipage/server-sent-events.html):
 * - Field accumulation with empty-line dispatch
 * - Multi-line `data:` joined with `\n`
 * - `id:` persistence across events (NULL byte values ignored)
 * - `retry:` parsed as non-negative integer
 * - Comment lines (`:` prefix) yielded as comment events
 *
 * @module shared/lib/transport/sse-parser
 */

export interface SSEEvent<T = unknown> {
  type: string;
  data: T;
  /** Last event ID, if set by the server. */
  id?: string;
  /** Reconnection interval in milliseconds, if set by the server. */
  retry?: number;
  /** True when this event represents an SSE comment line. */
  comment?: boolean;
}

/**
 * Parse an SSE byte stream into typed events.
 *
 * @param reader - ReadableStream reader from a fetch response
 * @param options - Error handling configuration
 */
export async function* parseSSEStream<T = unknown>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: { onParseError?: 'skip' | 'throw' }
): AsyncGenerator<SSEEvent<T>> {
  const decoder = new TextDecoder();
  const errorMode = options?.onParseError ?? 'skip';
  let buffer = '';
  let eventType = '';
  let dataLines: string[] = [];
  let eventId = '';
  let retryMs: number | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (dataLines.length > 0) yield* flushEvent();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          if (dataLines.length > 0) yield* flushEvent();
          continue;
        }
        if (line.startsWith(':')) {
          yield { type: 'comment', data: line.slice(1).trim() as T, comment: true };
          continue;
        }
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const field = line.slice(0, colonIdx);
        const val =
          line[colonIdx + 1] === ' ' ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1);

        switch (field) {
          case 'event':
            eventType = val;
            break;
          case 'data':
            dataLines.push(val);
            break;
          case 'id':
            // Per spec: ignore id fields containing NULL bytes
            if (!val.includes('\0')) eventId = val;
            break;
          case 'retry': {
            const parsed = parseInt(val, 10);
            if (!isNaN(parsed) && parsed >= 0) retryMs = parsed;
            break;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  /** Flush accumulated fields into a yielded event. */
  function* flushEvent(): Generator<SSEEvent<T>> {
    const rawData = dataLines.join('\n');
    let data: T;
    try {
      data = JSON.parse(rawData) as T;
    } catch (err) {
      // Only the `throw` mode keeps the error; the lenient mode deliberately
      // discards it and hands the caller the raw text instead.
      if (errorMode === 'throw') throw new Error('Malformed SSE JSON', { cause: err });
      data = rawData as T;
    }
    const event: SSEEvent<T> = { type: eventType || 'message', data };
    if (eventId) event.id = eventId;
    if (retryMs !== undefined) event.retry = retryMs;
    yield event;
    // Reset per-event accumulators (eventId persists across events per spec)
    eventType = '';
    dataLines = [];
    retryMs = undefined;
  }
}
