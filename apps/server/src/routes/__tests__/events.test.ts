import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

const mockUnsubscribe = vi.fn();
// Only the SINGLETON is doubled. `encodeBroadcast` stays real: it is a pure
// function that renders a frame into the two wire formats, and the assertions
// below are about the bytes a connecting client receives — a stub for it would
// be asserting the stub.
vi.mock('../../services/core/event-fan-out.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/event-fan-out.js')>()),
  eventFanOut: {
    hasCapacity: vi.fn(() => true),
    addClient: vi.fn(() => mockUnsubscribe),
  },
}));

import { createApp } from '../../app.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

/** Open an SSE connection and collect raw data until the connected event arrives. */
function collectConnectedEvent(): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        // Close once we have the connected event
        if (data.includes('event: connected') && data.includes('\n\n')) {
          req.destroy();
          resolve({ headers: res.headers, body: data });
        }
      });
      res.on('error', () => {
        // Expected when we destroy the request
        resolve({ headers: res.headers, body: data });
      });
    });
    req.on('error', (err) => {
      // Socket hang-up after destroy is expected
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      reject(err);
    });
  });
}

describe('GET /api/events (unified SSE stream)', () => {
  it('returns SSE headers', async () => {
    const { headers } = await collectConnectedEvent();

    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['connection']).toBe('keep-alive');
  });

  it('sends connected event on connection', async () => {
    const { body } = await collectConnectedEvent();

    expect(body).toContain('event: connected');
    expect(body).toContain('"connectedAt"');

    // Parse the data payload to verify it's valid JSON with a timestamp
    const dataLine = body.split('\n').find((line: string) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine!.replace('data: ', ''));
    expect(parsed.connectedAt).toBeDefined();
    expect(() => new Date(parsed.connectedAt)).not.toThrow();
  });

  it('registers client with eventFanOut.addClient', async () => {
    await collectConnectedEvent();

    expect(eventFanOut.addClient).toHaveBeenCalledTimes(1);
  });

  it('answers 503 BEFORE the SSE headers when the fan-out is full', async () => {
    // Ordering is the whole point: writing 200 + `text/event-stream` and then
    // failing leaves a client parsing an error page as a stream. It has to be a
    // plain JSON refusal it can read.
    vi.mocked(eventFanOut.hasCapacity).mockReturnValueOnce(false);

    const { status, headers, body } = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = http.get(`${baseUrl}/api/events`, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (raw += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw })
        );
      });
      req.on('error', reject);
    });

    expect(status).toBe(503);
    expect(headers['content-type']).toContain('application/json');
    expect(JSON.parse(body)).toEqual({ error: 'Too many SSE clients' });
    expect(eventFanOut.addClient).not.toHaveBeenCalled();
  });
});
