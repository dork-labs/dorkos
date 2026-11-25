import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import { initSSEStream, sendSSEEvent, endSSEStream } from '../streams/stream-adapter.js';

describe('Stream Adapter', () => {
  it('streams events as SSE frames over a real Node response', async () => {
    // The adapter takes Node's own `ServerResponse`, the raw response the Hono
    // routes reach through `@hono/node-server`; no Express in the path.
    const server = http.createServer(async (_req, res) => {
      initSSEStream(res);
      await sendSSEEvent(res, { type: 'text_delta', data: { text: 'hello' } });
      await sendSSEEvent(res, { type: 'done', data: { sessionId: '1' } });
      endSSEStream(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
      expect(await res.text()).toBe(
        'event: text_delta\ndata: {"text":"hello"}\n\n' + 'event: done\ndata: {"sessionId":"1"}\n\n'
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('waits for drain before resolving when the socket buffer is full', async () => {
    let drain: () => void = () => {};
    const res = {
      write: vi.fn().mockReturnValue(false),
      once: vi.fn((event: string, cb: () => void) => {
        if (event === 'drain') drain = cb;
      }),
    } as unknown as ServerResponse;

    let resolved = false;
    const sent = sendSSEEvent(res, { type: 'done', data: {} }).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    drain();
    await sent;
    expect(resolved).toBe(true);
  });
});
