/**
 * Reusable SSE stream parser for the Transport layer.
 *
 * @module shared/lib/transport/sse-parser
 */

export interface SSEEvent<T = unknown> {
  type: string;
  data: T;
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let eventType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ') && eventType) {
          try {
            const data = JSON.parse(line.slice(6)) as T;
            yield { type: eventType, data };
          } catch {
            if (errorMode === 'throw') throw new Error('Malformed SSE JSON');
            // 'skip' — silently drop malformed lines
          }
          eventType = '';
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
