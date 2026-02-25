/**
 * SSE stream helpers — format `StreamEvent` objects as Server-Sent Events wire protocol.
 *
 * @module services/stream-adapter
 */
import type { Response } from 'express';
import type { StreamEvent } from '@dorkos/shared/types';

/** Initialize an Express response for SSE streaming with appropriate headers. */
export function initSSEStream(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/** Write a single StreamEvent as an SSE message (event type + JSON data). */
export function sendSSEEvent(res: Response, event: StreamEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

/** End the SSE stream and close the response. */
export function endSSEStream(res: Response): void {
  res.end();
}
