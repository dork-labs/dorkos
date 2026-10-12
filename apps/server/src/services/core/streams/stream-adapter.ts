/**
 * SSE stream helpers — format `StreamEvent` objects as Server-Sent Events wire protocol.
 *
 * @module services/core/streams/stream-adapter
 */
import type { ServerResponse } from 'node:http';
import type { StreamEvent } from '@dorkos/shared/types';

/** Initialize a response for SSE streaming with appropriate headers. */
export function initSSEStream(res: Pick<ServerResponse, 'writeHead'>): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/** Write a single StreamEvent as an SSE message with backpressure handling. */
export async function sendSSEEvent(
  res: Pick<ServerResponse, 'write' | 'once'>,
  event: StreamEvent
): Promise<void> {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  const ok = res.write(payload);
  if (!ok) {
    await new Promise<void>((resolve) => res.once('drain', resolve));
  }
}

/** End the SSE stream and close the response. */
export function endSSEStream(res: Pick<ServerResponse, 'end'>): void {
  res.end();
}
