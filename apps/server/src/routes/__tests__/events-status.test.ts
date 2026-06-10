/**
 * Integration tests for global session-list discovery → unified `/api/events` SSE.
 *
 * Exercises {@link SessionListBroadcaster} against the real `eventFanOut` and the
 * real `GET /api/events` route over an HTTP socket: a `SessionListEvent` yielded
 * by a `FakeAgentRuntime` must reach the wire under its `type` event name with no
 * polling. Also covers schema validation (invalid events dropped, not crashed)
 * and `stop()` closing the runtime iterator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { FakeAgentRuntime, createMockSession } from '@dorkos/test-utils';

// createApp() reads tunnel + config state at construction — stub both so the
// app builds without a live ConfigManager. The real eventFanOut is intentionally
// NOT mocked: these tests assert events reach the SSE wire.
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

import { createApp } from '../../app.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { SessionListBroadcaster } from '../../services/session/session-list-broadcaster.js';

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
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

/**
 * A hand-driven async iterable of session-list events. `push()` delivers the
 * next event (or buffers it); `end()`/`return()` terminates the stream. Lets a
 * test feed the broadcaster on its own schedule and observe `.return()` calls.
 */
function controllableSessionList(): {
  iterable: AsyncIterable<SessionListEvent>;
  push: (event: SessionListEvent) => void;
  end: () => void;
  returned: () => boolean;
} {
  const queue: SessionListEvent[] = [];
  let waiter: ((r: IteratorResult<SessionListEvent>) => void) | null = null;
  let done = false;
  let didReturn = false;

  const deliver = (result: IteratorResult<SessionListEvent>): void => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(result);
    }
  };

  return {
    returned: () => didReturn,
    push: (event) => {
      if (done) return;
      if (waiter) deliver({ value: event, done: false });
      else queue.push(event);
    },
    end: () => {
      done = true;
      deliver({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SessionListEvent>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              waiter = resolve;
            });
          },
          return(): Promise<IteratorResult<SessionListEvent>> {
            didReturn = true;
            done = true;
            deliver({ value: undefined, done: true });
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  };
}

/**
 * A single live SSE connection to `/api/events`. `waitFor(predicate)` resolves
 * once the accumulated body matches; `close()` tears the socket down. Reusing one
 * connection across awaits is essential: the client must be registered with the
 * fan-out (proven by the `connected` event) BEFORE an event is broadcast, or the
 * broadcast races ahead of registration on a fresh socket.
 */
function openEventStream(): {
  waitFor: (predicate: (body: string) => boolean) => Promise<string>;
  close: () => void;
} {
  let body = '';
  const listeners = new Set<() => void>();
  const req = http.get(`${baseUrl}/api/events`, (res) => {
    res.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      for (const notify of listeners) notify();
    });
    res.on('error', () => {});
  });
  req.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') throw err;
  });

  return {
    close: () => req.destroy(),
    waitFor: (predicate) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for SSE event')), 3000);
        const check = (): void => {
          if (predicate(body)) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(body);
          }
        };
        listeners.add(check);
        check();
      }),
  };
}

/** Parse the `data:` payload of the first SSE frame carrying `eventName`. */
function parseEventData(body: string, eventName: string): unknown {
  const frame = body.split('\n\n').find((f) => f.includes(`event: ${eventName}`));
  const dataLine = frame?.split('\n').find((l) => l.startsWith('data: '));
  return dataLine ? JSON.parse(dataLine.replace('data: ', '')) : undefined;
}

describe('GET /api/events — global session-list broadcaster', () => {
  let broadcaster: SessionListBroadcaster;
  let runtime: FakeAgentRuntime;

  beforeEach(() => {
    broadcaster = new SessionListBroadcaster();
    runtime = new FakeAgentRuntime();
  });

  afterEach(async () => {
    await broadcaster.stop();
    vi.restoreAllMocks();
  });

  // Sessions carry UUID ids per SessionSchema; non-UUID ids fail validation.
  const SESSION_ID = '11111111-1111-4111-8111-111111111111';

  it('external-session liveness: a session_upserted yielded by the runtime reaches /api/events with no poll', async () => {
    const control = controllableSessionList();
    runtime.subscribeSessionList.mockReturnValue(control.iterable);
    const session = createMockSession({ id: SESSION_ID, title: 'CLI session' });

    const stream = openEventStream();
    await stream.waitFor((body) => body.includes('event: connected')); // registered with fan-out

    broadcaster.start(runtime);
    // Simulate an externally-created session surfacing via the runtime watcher.
    control.push({ type: 'session_upserted', session });

    const body = await stream.waitFor((b) => b.includes('event: session_upserted'));
    stream.close();
    const payload = parseEventData(body, 'session_upserted') as SessionListEvent;
    expect(payload).toMatchObject({ type: 'session_upserted', session: { id: SESSION_ID } });
  });

  it('broadcasts session_removed under its own event name', async () => {
    const control = controllableSessionList();
    runtime.subscribeSessionList.mockReturnValue(control.iterable);

    const stream = openEventStream();
    await stream.waitFor((body) => body.includes('event: connected'));
    broadcaster.start(runtime);
    control.push({ type: 'session_removed', sessionId: SESSION_ID });

    const body = await stream.waitFor((b) => b.includes('event: session_removed'));
    stream.close();
    const payload = parseEventData(body, 'session_removed') as SessionListEvent;
    expect(payload).toMatchObject({ type: 'session_removed', sessionId: SESSION_ID });
  });

  it('validates against SessionListEventSchema: an invalid event is dropped, a later valid one still flows', async () => {
    const control = controllableSessionList();
    runtime.subscribeSessionList.mockReturnValue(control.iterable);
    const broadcastSpy = vi.spyOn(eventFanOut, 'broadcast');

    const stream = openEventStream();
    await stream.waitFor((body) => body.includes('event: connected'));
    broadcaster.start(runtime);

    // Invalid: session_upserted with no `session` field — must be dropped, not crash.
    control.push({ type: 'session_upserted' } as unknown as SessionListEvent);
    // A valid event after the bad one proves the loop survived.
    control.push({ type: 'session_removed', sessionId: SESSION_ID });

    const body = await stream.waitFor((b) => b.includes('event: session_removed'));
    stream.close();
    expect(body).toContain('event: session_removed');
    // The invalid event must NOT have been broadcast.
    expect(broadcastSpy).not.toHaveBeenCalledWith('session_upserted', expect.anything());
  });
});

describe('SessionListBroadcaster lifecycle', () => {
  it('stop() closes the runtime iterator via return()', async () => {
    const control = controllableSessionList();
    const runtime = new FakeAgentRuntime();
    runtime.subscribeSessionList.mockReturnValue(control.iterable);
    const broadcaster = new SessionListBroadcaster();

    broadcaster.start(runtime);
    await broadcaster.stop();

    expect(control.returned()).toBe(true);
  });

  it('start() is idempotent — a second call while running does not re-subscribe', () => {
    const runtime = new FakeAgentRuntime();
    runtime.subscribeSessionList.mockReturnValue(controllableSessionList().iterable);
    const broadcaster = new SessionListBroadcaster();

    broadcaster.start(runtime);
    broadcaster.start(runtime);

    expect(runtime.subscribeSessionList).toHaveBeenCalledTimes(1);
  });

  // Failure mode (I3): the "never blocks startup" guarantee is broken if iterator
  // construction throws synchronously (e.g. chokidar failing). start() is called
  // from index.ts with no try/catch, so an uncaught throw would crash boot. It
  // must be swallowed: log, leave discovery off, server stays up.
  it('start() does not throw when subscribeSessionList throws synchronously', () => {
    const runtime = new FakeAgentRuntime();
    runtime.subscribeSessionList.mockImplementation(() => {
      throw new Error('watcher failed to start');
    });
    const broadcaster = new SessionListBroadcaster();

    expect(() => broadcaster.start(runtime)).not.toThrow();
    // Discovery is left off, so a later start() can retry (running was reset).
    runtime.subscribeSessionList.mockReturnValue(controllableSessionList().iterable);
    expect(() => broadcaster.start(runtime)).not.toThrow();
    expect(runtime.subscribeSessionList).toHaveBeenCalledTimes(2);
  });
});
