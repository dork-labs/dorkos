import request from 'supertest';
import type { Express } from 'express';
import type { StreamEvent } from '@dorkos/shared/types';

/**
 * Sends a message to a session and collects all SSE StreamEvents emitted
 * before the connection closes. Uses supertest's buffer(true) + parse()
 * pattern for synchronous SSE collection in tests.
 *
 * Handles the DorkOS SSE wire format: `event: {type}\ndata: {json}\n\n`.
 * Reconstructs full StreamEvent objects from event/data line pairs.
 *
 * @param app - Express app instance (from createApp())
 * @param sessionId - Target session UUID
 * @param content - User message text to send
 * @returns Ordered array of StreamEvents emitted during the response
 */
export async function collectSseEvents(
  app: Express,
  sessionId: string,
  content: string
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];

  await request(app)
    .post(`/api/sessions/${sessionId}/messages`)
    .set('Accept', 'text/event-stream')
    .send({ content })
    .buffer(true)
    .parse((res, callback) => {
      let buffer = '';
      let currentType = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && currentType) {
            try {
              const data = JSON.parse(line.slice(6)) as unknown;
              events.push({ type: currentType, data } as StreamEvent);
            } catch {
              // Non-JSON SSE lines (e.g., comments) are silently ignored
            }
            currentType = '';
          }
        }
      });
      res.on('end', () => callback(null, events));
    });

  return events;
}
