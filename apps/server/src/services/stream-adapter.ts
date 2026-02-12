import type { Response } from 'express';
import type { StreamEvent } from '@lifeos/shared/types';

export function initSSEStream(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

export function sendSSEEvent(res: Response, event: StreamEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

export function endSSEStream(res: Response): void {
  res.end();
}
