/**
 * URL-targeting SSE collector: `collectDurableEventsAt` connects to an EXISTING
 * server port (the credentialed child-process case) and parses `id:`/`event:`/
 * `data:` frames with the same parser `collectDurableEvents` uses. Driven here
 * against a throwaway `http` server emitting canned SSE frames.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectDurableEventsAt, type SseFrame } from '@dorkos/test-utils';

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** Boot a throwaway SSE server that writes `wire` then optionally ends. */
async function startSseServer(wire: string, opts: { end?: boolean } = {}): Promise<string> {
  const end = opts.end ?? true;
  server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(wire);
    if (end) res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Serialize a frame to SSE wire text (`id:`/`event:`/`data:`). */
function frame(event: string, data: unknown, id?: string): string {
  const idLine = id !== undefined ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('collectDurableEventsAt', () => {
  it('parses id/event/data frames from an existing server port', async () => {
    const wire =
      frame('snapshot', { cursor: 0 }, 'sess-0') + frame('turn_end', { seq: 3 }, 'sess-3');
    const baseUrl = await startSseServer(wire);

    const { frames, status } = await collectDurableEventsAt(baseUrl, 'sess');
    expect(status).toBe(200);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual<SseFrame>({ id: 'sess-0', event: 'snapshot', data: { cursor: 0 } });
    expect(frames[1]).toEqual<SseFrame>({ id: 'sess-3', event: 'turn_end', data: { seq: 3 } });
  });

  it('stops at the `until` predicate without waiting for the stream to end', async () => {
    // The server never ends the stream; only `until` closes the connection.
    const wire =
      frame('snapshot', { cursor: 0 }) +
      frame('text_delta', { text: 'A' }) +
      frame('turn_end', { seq: 9 });
    const baseUrl = await startSseServer(wire, { end: false });

    const { frames } = await collectDurableEventsAt(baseUrl, 'sess', {
      until: (fs) => fs.some((f) => f.event === 'turn_end'),
    });
    expect(frames.map((f) => f.event)).toContain('turn_end');
  });

  it('sends the Last-Event-ID resume header', async () => {
    let seenHeader: string | undefined;
    server = http.createServer((req, res) => {
      seenHeader = req.headers['last-event-id'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame('snapshot', { cursor: 5 }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server!.address() as AddressInfo;

    await collectDurableEventsAt(`http://127.0.0.1:${port}`, 'sess', { lastEventId: 'sess-5' });
    expect(seenHeader).toBe('sess-5');
  });
});
