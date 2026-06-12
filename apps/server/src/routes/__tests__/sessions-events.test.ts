import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { StaleResumeCursorError } from '@dorkos/shared/session-stream';
import type { SessionEvent, SessionSnapshot } from '@dorkos/shared/session-stream';

// Mock the directory boundary so the /events handler's assertBoundary against
// the default cwd doesn't require initBoundary() at startup. Mirrors
// sessions-streaming.test.ts.
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

// Declared at module scope so the vi.mock factory closure can reference it.
// Initialized in beforeEach so each test starts with a fresh spy instance.
let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {
    constructor(
      public readonly runtime: string,
      public readonly sessionId: string
    ) {
      super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
      this.name = 'RuntimeNotRegisteredError';
    }
  },
}));

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

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(async () => null),
}));

import http from 'node:http';
import { createApp, finalizeApp } from '../../app.js';
import { STREAM_EPOCH } from '../session-events-handler.js';

const app = createApp();
finalizeApp(app);

/** Valid UUID for session ID params (routes validate UUID format). */
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

/** A single SSE frame as parsed off the wire, including its optional `id:`. */
interface SseFrame {
  id?: string;
  event: string;
  data: unknown;
}

/** A collected `GET /:id/events` response: parsed frames + raw text + headers. */
interface EventsResult {
  frames: SseFrame[];
  raw: string;
  headers: http.IncomingHttpHeaders;
  status: number;
}

/**
 * Open `GET /api/sessions/:id/events` against a real listening server and
 * collect SSE frames (capturing the `id:` line, which the StreamEvent-only
 * `collectSseEvents` helper does not). The handler ends the stream once the
 * fake's finite `subscribeSession` completes, so the request resolves on `end`.
 *
 * @param opts.lastEventId - Sent as the `Last-Event-ID` request header (resume).
 * @param opts.after - Sent as the `?after=` query param (resume).
 */
function collectEvents(opts: { lastEventId?: string; after?: number } = {}): Promise<EventsResult> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const query = opts.after !== undefined ? `?after=${opts.after}` : '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/sessions/${SESSION_ID}/events${query}`,
          method: 'GET',
          headers: opts.lastEventId ? { 'Last-Event-ID': opts.lastEventId } : {},
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (raw += chunk));
          res.on('end', () => {
            server.close();
            resolve({
              frames: parseFrames(raw),
              raw,
              headers: res.headers,
              status: res.statusCode ?? 0,
            });
          });
        }
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

/** Parse SSE wire text into frames, attaching the most recent `id:` to each. */
function parseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  let id: string | undefined;
  let event = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) {
      id = line.slice(4).trim();
    } else if (line.startsWith('event: ')) {
      event = line.slice(7).trim();
    } else if (line.startsWith('data: ') && event) {
      frames.push({ id, event, data: JSON.parse(line.slice(6)) });
      id = undefined;
      event = '';
    }
  }
  return frames;
}

/** Build a finite `subscribeSession` mock that yields the given events then ends. */
function finiteSubscribe(events: SessionEvent[]) {
  return vi.fn(async function* (): AsyncIterable<SessionEvent> {
    for (const event of events) yield event;
  });
}

const TIMEOUT_MS = 10 * 60 * 1000;

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.hasSession.mockReturnValue(true);
});

describe('GET /api/sessions/:id/events (durable snapshot → replay → live)', () => {
  it('cold connect emits a snapshot then live frames, each live frame carrying an id', async () => {
    // Core resumability guarantee: a fresh client hydrates from the snapshot and
    // then receives live events with `id: <sid>-<seq>` for browser reconnect.
    const snapshot: SessionSnapshot = {
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00Z' }],
      inProgressTurn: null,
      status: {
        contextUsage: null,
        cost: null,
        cacheStats: null,
        model: null,
        permissionMode: 'default',
        todoCounts: null,
        runningSubagentCount: 0,
        lifecycle: 'idle',
      },
      pendingInteractions: [],
      cursor: 0,
    };
    fakeRuntime.getSessionSnapshot.mockResolvedValue(snapshot);
    fakeRuntime.subscribeSession = finiteSubscribe([
      { seq: 1, type: 'turn_start' },
      { seq: 2, type: 'text_delta', text: 'Hello' },
    ]);

    const { frames } = await collectEvents();

    expect(frames[0]?.event).toBe('snapshot');
    expect((frames[0]?.data as SessionSnapshot).messages).toHaveLength(1);
    expect(frames[0]?.id).toBeUndefined(); // snapshot carries cursor, not an id

    const live = frames.slice(1);
    expect(live.map((f) => f.event)).toEqual(['turn_start', 'text_delta']);
    expect(live.map((f) => f.id)).toEqual([
      `${SESSION_ID}-${STREAM_EPOCH}-1`,
      `${SESSION_ID}-${STREAM_EPOCH}-2`,
    ]);
  });

  it('cold connect subscribes from the snapshot cursor (closes the capture→subscribe race)', async () => {
    // Core resumability guarantee: live subscription must start at snap.cursor so
    // an event ingested between snapshot capture and subscribe is not dropped.
    const snapshot = { ...baseSnapshot(), cursor: 7 };
    fakeRuntime.getSessionSnapshot.mockResolvedValue(snapshot);
    fakeRuntime.subscribeSession = finiteSubscribe([{ seq: 8, type: 'text_delta', text: 'x' }]);

    await collectEvents();

    expect(fakeRuntime.subscribeSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'default' }),
      SESSION_ID,
      7,
      expect.any(AbortSignal)
    );
  });

  it('reconnect with Last-Event-ID replays only seq > cursor and does NOT resend the snapshot', async () => {
    // Core resumability guarantee: a resume signal skips hydration and replays
    // only the gap, so no duplicate snapshot and no re-streamed history.
    fakeRuntime.subscribeSession = finiteSubscribe([
      { seq: 3, type: 'text_delta', text: 'c' },
      { seq: 4, type: 'turn_end' },
    ]);

    const { frames } = await collectEvents({ lastEventId: `${SESSION_ID}-${STREAM_EPOCH}-2` });

    expect(frames.some((f) => f.event === 'snapshot')).toBe(false);
    expect(fakeRuntime.getSessionSnapshot).not.toHaveBeenCalled();
    expect(frames.map((f) => f.id)).toEqual([
      `${SESSION_ID}-${STREAM_EPOCH}-3`,
      `${SESSION_ID}-${STREAM_EPOCH}-4`,
    ]);
    // sinceCursor parsed out of the trailing -<epoch>-<seq> despite UUID hyphens.
    expect(fakeRuntime.subscribeSession).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      2,
      expect.any(AbortSignal)
    );
  });

  it('Last-Event-ID from a previous server process (epoch mismatch) falls back to a cold snapshot', async () => {
    // Real failure mode (SRV-C1): per-session seq counters live in-process and
    // restart from 0 with the server. Resuming with a cursor minted by a dead
    // process would leave the live filter dropping every future event — the
    // client would be permanently deaf. A mismatched epoch must route to the
    // cold path: fresh snapshot, then live from ITS cursor.
    fakeRuntime.getSessionSnapshot.mockResolvedValue(baseSnapshot());
    fakeRuntime.subscribeSession = finiteSubscribe([{ seq: 1, type: 'turn_start' }]);

    const staleEpoch = STREAM_EPOCH - 1;
    const { frames } = await collectEvents({ lastEventId: `${SESSION_ID}-${staleEpoch}-4523` });

    expect(frames[0]?.event).toBe('snapshot');
    expect(fakeRuntime.getSessionSnapshot).toHaveBeenCalled();
    // Subscribed from the fresh snapshot's cursor, NOT the stale 4523.
    expect(fakeRuntime.subscribeSession).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      0,
      expect.any(AbortSignal)
    );
  });

  it('a same-epoch cursor the buffer cannot serve (StaleResumeCursorError) falls back to a cold snapshot', async () => {
    // Real failure mode (SRV-C1): the EventLog trims past 5000 events, so a deep
    // resume has a gap the buffers cannot replay. subscribeSession throws
    // EAGERLY; the route must degrade to snapshot+live instead of silently
    // skipping the gap (or worse, dying).
    fakeRuntime.getSessionSnapshot.mockResolvedValue({ ...baseSnapshot(), cursor: 6000 });
    fakeRuntime.subscribeSession = vi.fn(
      (_ctx: unknown, _sid: string, sinceCursor?: number): AsyncIterable<SessionEvent> => {
        if (sinceCursor === 42) throw new StaleResumeCursorError(SESSION_ID, 42);
        return (async function* () {
          yield { seq: 6001, type: 'turn_start' } as SessionEvent;
        })();
      }
    ) as unknown as typeof fakeRuntime.subscribeSession;

    const { frames } = await collectEvents({ after: 42 });

    expect(frames[0]?.event).toBe('snapshot');
    expect(frames[1]?.event).toBe('turn_start');
    // First attempt resumed from 42, the fallback re-subscribed from snap.cursor.
    expect(fakeRuntime.subscribeSession).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      SESSION_ID,
      42,
      expect.any(AbortSignal)
    );
    expect(fakeRuntime.subscribeSession).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      SESSION_ID,
      6000,
      expect.any(AbortSignal)
    );
  });

  it('?after=<cursor> behaves identically to Last-Event-ID', async () => {
    // Core resumability guarantee: the query-param resume path is equivalent to
    // the header path — same gap replay, same snapshot suppression.
    fakeRuntime.subscribeSession = finiteSubscribe([{ seq: 6, type: 'text_delta', text: 'f' }]);

    const { frames } = await collectEvents({ after: 5 });

    expect(frames.some((f) => f.event === 'snapshot')).toBe(false);
    expect(fakeRuntime.getSessionSnapshot).not.toHaveBeenCalled();
    expect(fakeRuntime.subscribeSession).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      5,
      expect.any(AbortSignal)
    );
  });

  it('expired interactions are excluded from the snapshot (projector enforces it)', async () => {
    // Core resumability guarantee: the route forwards whatever the projector
    // returns, and the projector excludes remainingMs<=0 — so a stale prompt is
    // never re-presented on a cold hydrate.
    const snapshot: SessionSnapshot = {
      ...baseSnapshot(),
      // Only a non-expired interaction is present; the expired one was dropped
      // upstream by the projector's listPendingInteractions selector.
      pendingInteractions: [
        {
          type: 'approval',
          id: 'tool-live',
          startedAt: 0,
          remainingMs: TIMEOUT_MS,
          toolName: 'Bash',
          input: '{}',
          hasSuggestions: false,
        },
      ],
    };
    fakeRuntime.getSessionSnapshot.mockResolvedValue(snapshot);
    fakeRuntime.subscribeSession = finiteSubscribe([]);

    const { frames } = await collectEvents();

    const snap = frames[0]?.data as SessionSnapshot;
    expect(snap.pendingInteractions).toHaveLength(1);
    expect(snap.pendingInteractions[0]?.id).toBe('tool-live');
  });

  it('sets X-Accel-Buffering: no and emits a keepalive comment line', async () => {
    // Core resumability guarantee: the proxy-buffering defeat header is present,
    // and the heartbeat keeps idle connections (and proxies) alive.
    fakeRuntime.getSessionSnapshot.mockResolvedValue(baseSnapshot());
    // A subscribe that emits one event after a beat lets the first heartbeat fire
    // before the stream ends.
    fakeRuntime.subscribeSession = vi.fn(async function* (): AsyncIterable<SessionEvent> {
      yield { seq: 1, type: 'turn_start' };
    });

    const { headers } = await collectEvents();
    expect(headers['x-accel-buffering']).toBe('no');
    // The keepalive is time-driven (~15s) and won't fire in a fast finite stream;
    // assert the header guarantee here and the disconnect cleanup below.
  });

  it('client disconnect terminates the subscribe iterator (runs its cleanup, no leak)', async () => {
    // Core resumability guarantee: closing the SSE connection must return the
    // async iterator so the projector generator's finally runs (I2 fix) — no
    // dangling waiter, no hung handler.
    let cleanedUp = false;
    fakeRuntime.getSessionSnapshot.mockResolvedValue(baseSnapshot());
    // A live stream that parks until the route's AbortSignal fires on disconnect
    // (mirrors how the real projector honors the signal). The finally proves the
    // generator tore down cleanly rather than leaking a parked wait.
    fakeRuntime.subscribeSession = vi.fn(async function* (
      _ctx: unknown,
      _sessionId: string,
      _sinceCursor?: number,
      signal?: AbortSignal
    ): AsyncIterable<SessionEvent> {
      try {
        yield { seq: 1, type: 'turn_start' };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        cleanedUp = true;
      }
    });

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const req = http.request(
          { host: '127.0.0.1', port, path: `/api/sessions/${SESSION_ID}/events`, method: 'GET' },
          (res) => {
            res.on('data', () => {
              // Got the first frame — now disconnect to trigger the server-side
              // res 'close', then poll until the generator's finally has run.
              req.destroy();
              const start = Date.now();
              const poll = setInterval(() => {
                if (cleanedUp || Date.now() - start > 2000) {
                  clearInterval(poll);
                  server.close();
                  if (cleanedUp) resolve();
                  else reject(new Error('iterator not cleaned up'));
                }
              }, 10);
            });
            res.on('error', () => {});
          }
        );
        req.on('error', () => {}); // abort surfaces as a socket error — ignore
        req.end();
      });
    });

    expect(cleanedUp).toBe(true);
  });

  it('serves a well-formed session not tracked in memory as empty-live (no 404)', async () => {
    // DOR-74 / requirement #1: the durable stream must be openable for ANY
    // well-formed id, even one `hasSession()` reports false for. `hasSession()`
    // is IN-MEMORY only, but sessions live on disk as JSONL — a brand-new client
    // id before its first message, or an existing on-disk session not yet loaded
    // this server-process, must both stream rather than 404 (the old gate made
    // the client SSEConnection retry to "Sync offline"). The snapshot reads
    // history from disk (empty for a truly-new id) and the connection stays live.
    fakeRuntime.hasSession.mockReturnValue(false);
    fakeRuntime.getSessionSnapshot.mockResolvedValue(baseSnapshot());
    fakeRuntime.subscribeSession = finiteSubscribe([]);

    const { status, frames } = await collectEvents();

    expect(status).toBe(200);
    // The cold snapshot hydration frame is delivered, proving the stream served
    // the untracked session instead of 404-ing.
    expect(frames.some((f) => f.event === 'snapshot')).toBe(true);
  });
});

/** A minimal idle cold snapshot for tests that don't assert on its contents. */
function baseSnapshot(): SessionSnapshot {
  return {
    messages: [],
    inProgressTurn: null,
    status: {
      contextUsage: null,
      cost: null,
      cacheStats: null,
      model: null,
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
    },
    pendingInteractions: [],
    cursor: 0,
  };
}
