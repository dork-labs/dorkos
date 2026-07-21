/**
 * Drive loop: POST-trigger a turn and collect it off the durable `/events`
 * stream to its terminal `turn_end`. Driven against a `FakeAgentRuntime`
 * scenario streamed through an in-process server that honors the trigger-only
 * contract (202 + subscribe-first delivery, ADR-0264). Pins: the subscribe→POST
 * →collect loop, the `turn_end` terminator, a `409 SESSION_LOCKED` runner error,
 * the timeout guard, and the live abort guard.
 *
 * Hardening pins (PR #331 review): the `/events` connection is destroyed on
 * EVERY exit path (success, timeout, abort, connection error, rejected trigger)
 * so the durable GET is never leaked; `ready` rejects — never hangs — when the
 * connection errors before the snapshot or the snapshot never arrives; and
 * `driveConversation` threads the canonical id across turns and stops early on a
 * non-`done` outcome.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { driveTurn, driveConversation, driveWidgetAction, DriveError } from '../drive.js';

let server: http.Server | undefined;
/** The last trigger POST the fake server received (path + parsed body). */
let capturedPost: { path: string; body: unknown } | undefined;

afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  capturedPost = undefined;
  vi.restoreAllMocks();
});

/** Spy on the shared ClientRequest.destroy so a test can assert the /events GET was torn down. */
function spyOnConnectionDestroy(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(http.ClientRequest.prototype, 'destroy');
}

/** Serialize one durable SessionEvent to SSE wire text. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Project a runtime StreamEvent onto a durable SessionEvent frame (minimal). */
function projectEvent(ev: StreamEvent, seq: number): string | null {
  if (ev.type === 'done') return null; // becomes the terminal turn_end
  if (ev.type === 'session_status') {
    const d = ev.data as { usage?: unknown; costUsd?: number };
    const status: Record<string, unknown> = {};
    if (d.usage !== undefined) status.usage = d.usage;
    if (typeof d.costUsd === 'number') status.cost = d.costUsd;
    return sse('status_change', { type: 'status_change', seq, status });
  }
  return sse(ev.type, { type: ev.type, seq, ...(ev.data as object) });
}

/**
 * A fake server that speaks the trigger-only contract: GET `/events` sends the
 * cold snapshot and holds the connection; POST `/messages` returns 202 and THEN
 * streams the `FakeAgentRuntime` scenario onto the held connection (turn_start →
 * projected frames → turn_end) — so a subscribe-first driver never misses it.
 */
async function startFakeServer(
  runtime: FakeAgentRuntime,
  opts: { lockCode?: number } = {}
): Promise<string> {
  const live = new Map<string, http.ServerResponse>();
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const sessionId = url.pathname.split('/')[3];

    if (req.method === 'GET' && url.pathname.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse('snapshot', { cursor: 0, status: { lifecycle: 'idle' } }));
      live.set(sessionId, res);
      return;
    }

    if (
      req.method === 'POST' &&
      (url.pathname.endsWith('/messages') || url.pathname.endsWith('/ui-action'))
    ) {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        capturedPost = { path: url.pathname, body: body ? JSON.parse(body) : undefined };
        if (opts.lockCode) {
          res.writeHead(opts.lockCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'SESSION_LOCKED' }));
          return;
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionId }));
        // Stream the turn onto the held /events connection.
        void (async () => {
          const sink = live.get(sessionId);
          if (!sink) return;
          let seq = 1;
          sink.write(sse('turn_start', { type: 'turn_start', seq: seq++ }));
          for await (const ev of runtime.sendMessage(sessionId, 'x', {})) {
            const frame = projectEvent(ev as StreamEvent, seq++);
            if (frame) sink.write(frame);
          }
          sink.write(sse('turn_end', { type: 'turn_end', seq: seq++ }));
        })();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * A fake server that simulates claude-code re-minting its internal session id
 * mid-turn (DOR-397): the trigger POST's 202 body reports `remappedId` — a
 * DIFFERENT id than the one the caller subscribed under — and the turn's
 * frames stream onto a `/events` connection opened under `remappedId`, never
 * the pre-remap id. A driver that keeps collecting on its original
 * subscription would see nothing but the cold snapshot and time out; a
 * remap-robust driver re-subscribes to `remappedId` and collects there. The
 * POST handler waits for the remapped `/events` connection to arrive before
 * streaming (mirrors subscribe-before-trigger ordering, just on the NEW id).
 */
async function startRemapFakeServer(
  runtime: FakeAgentRuntime,
  remappedId: string
): Promise<string> {
  const live = new Map<string, http.ServerResponse>();
  const waitForSink = (id: string): Promise<http.ServerResponse> =>
    new Promise((resolve) => {
      const poll = (): void => {
        const sink = live.get(id);
        if (sink) resolve(sink);
        else setTimeout(poll, 5);
      };
      poll();
    });

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const sessionId = url.pathname.split('/')[3];

    if (req.method === 'GET' && url.pathname.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse('snapshot', { cursor: 0, status: { lifecycle: 'idle' } }));
      live.set(sessionId, res);
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        capturedPost = { path: url.pathname, body: body ? JSON.parse(body) : undefined };
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionId: remappedId }));
        // Stream the turn onto the REMAPPED id's /events connection only —
        // the pre-remap subscription under `sessionId` is never written to.
        void (async () => {
          const sink = await waitForSink(remappedId);
          let seq = 1;
          sink.write(sse('turn_start', { type: 'turn_start', seq: seq++ }));
          for await (const ev of runtime.sendMessage(remappedId, 'x', {})) {
            const frame = projectEvent(ev as StreamEvent, seq++);
            if (frame) sink.write(frame);
          }
          sink.write(sse('turn_end', { type: 'turn_end', seq: seq++ }));
        })();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * A server that accepts GET `/events` with a 200 but writes NO snapshot and
 * holds the connection open — so the subscribe gate never resolves on its own
 * and only the ready-wait timeout can end the wait.
 */
async function startSilentEventsServer(): Promise<string> {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '', 'http://x').pathname;
    if (req.method === 'GET' && pathname.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Deliberately write nothing: no snapshot ever arrives.
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Bind then immediately release a port so nothing listens on it — a connect there yields ECONNREFUSED. */
async function closedBaseUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('driveTurn', () => {
  it('POST→collect→terminal turn_end, returning the canonical id and ordered frames, and destroys the /events GET', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'Hi' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startFakeServer(runtime);
    const destroySpy = spyOnConnectionDestroy();

    const result = await driveTurn({
      baseUrl,
      sessionId: 'sess-1',
      content: 'Hello',
      cwd: '/tmp/proj',
    });

    expect(result.outcome).toBe('done');
    expect(result.canonicalId).toBe('sess-1');
    const events = result.frames.map((f) => f.event);
    expect(events).toEqual(['snapshot', 'turn_start', 'text_delta', 'turn_end']);
    // Success path must tear the durable GET down, not leak it.
    expect(destroySpy).toHaveBeenCalled();
  });

  it('collects a session_status cost frame so the budget guard can read it', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield {
          type: 'session_status',
          data: { usage: { kind: 'pay-as-you-go', costUsd: 0.02 } },
        } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startFakeServer(runtime);

    const result = await driveTurn({ baseUrl, sessionId: 's', content: 'go', cwd: '/tmp' });
    const status = result.frames.find((f) => f.event === 'status_change');
    expect((status?.data as { status: { usage: { costUsd: number } } }).status.usage.costUsd).toBe(
      0.02
    );
  });

  it('throws a DriveError on a 409 SESSION_LOCKED and destroys the /events GET (no leaked connection)', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([async function* () {}]);
    const baseUrl = await startFakeServer(runtime, { lockCode: 409 });
    const destroySpy = spyOnConnectionDestroy();

    await expect(
      driveTurn({ baseUrl, sessionId: 's', content: 'go', cwd: '/tmp', timeoutMs: 500 })
    ).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    // The rejected-trigger path must still destroy the durable GET.
    expect(destroySpy).toHaveBeenCalled();

    await expect(
      driveTurn({ baseUrl, sessionId: 's', content: 'go', cwd: '/tmp', timeoutMs: 500 })
    ).rejects.toBeInstanceOf(DriveError);
  });

  it('resolves `timeout` when the turn never reaches turn_end, and destroys the /events GET', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'partial' } } as StreamEvent;
        await new Promise(() => {}); // never yields done
      },
    ]);
    const baseUrl = await startFakeServer(runtime);
    const destroySpy = spyOnConnectionDestroy();

    const result = await driveTurn({
      baseUrl,
      sessionId: 's',
      content: 'go',
      cwd: '/tmp',
      timeoutMs: 150,
    });
    expect(result.outcome).toBe('timeout');
    expect(destroySpy).toHaveBeenCalled();
  });

  it('stops with `aborted` when the live abort guard trips (budget ceiling), and destroys the /events GET', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'session_status', data: { costUsd: 5 } } as StreamEvent;
        await new Promise(() => {}); // keep streaming; abort must stop us
      },
    ]);
    const baseUrl = await startFakeServer(runtime);
    const destroySpy = spyOnConnectionDestroy();

    const result = await driveTurn({
      baseUrl,
      sessionId: 's',
      content: 'go',
      cwd: '/tmp',
      timeoutMs: 2000,
      abortWhen: (frames) =>
        frames.some(
          (f) =>
            f.event === 'status_change' &&
            (f.data as { status: { cost?: number } }).status.cost! > 1
        ),
    });
    expect(result.outcome).toBe('aborted');
    expect(destroySpy).toHaveBeenCalled();
  });

  it('rejects (never hangs) when the /events connection errors before the snapshot, and destroys the request', async () => {
    const baseUrl = await closedBaseUrl();
    const destroySpy = spyOnConnectionDestroy();

    // A connection error before any snapshot must reject `ready` (and therefore
    // the turn) rather than block forever on `await stream.ready`.
    await expect(
      driveTurn({ baseUrl, sessionId: 's', content: 'go', cwd: '/tmp', timeoutMs: 5000 })
    ).rejects.toMatchObject({ code: 'STREAM_ERROR' });
    expect(destroySpy).toHaveBeenCalled();
  });

  it('rejects (never hangs) when the snapshot never arrives within readyTimeoutMs, without waiting for the turn timeout', async () => {
    const baseUrl = await startSilentEventsServer();
    const destroySpy = spyOnConnectionDestroy();

    const start = Date.now();
    await expect(
      driveTurn({
        baseUrl,
        sessionId: 's',
        content: 'go',
        cwd: '/tmp',
        readyTimeoutMs: 100,
        timeoutMs: 5000,
      })
    ).rejects.toMatchObject({ code: 'STREAM_ERROR' });
    const elapsed = Date.now() - start;

    // It must trip the ready-wait timeout (~100ms), not the 5000ms turn timeout.
    expect(elapsed).toBeLessThan(2000);
    expect(destroySpy).toHaveBeenCalled();
  });

  it('fires NO trigger POST when the turn timeout beats the snapshot (no phantom, uncollected turn)', async () => {
    // The turn timer (80ms) wins the race against the ready gate (5000ms), so
    // `finish('timeout')` runs BEFORE the subscribe gate ever opened. It must
    // REJECT `ready` (not resolve it), or the driver would POST a trigger into
    // an already-destroyed stream — a lost turn. Regression guard for the
    // Phase-2 `finish()` hardening (spec Errata, PR #333 review).
    const baseUrl = await startSilentEventsServer();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      driveTurn({
        baseUrl,
        sessionId: 's',
        content: 'go',
        cwd: '/tmp',
        timeoutMs: 80,
        readyTimeoutMs: 5000,
      })
    ).rejects.toMatchObject({ code: 'STREAM_ERROR' });

    // The gate never opened, so the trigger was never fired.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('driveTurn — session-id remap (DOR-397)', () => {
  it('re-subscribes to the canonical id when the 202 reveals a remap, and still collects to turn_end', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'resumed' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startRemapFakeServer(runtime, 'sess-1-remapped');
    const destroySpy = spyOnConnectionDestroy();

    const result = await driveTurn({
      baseUrl,
      sessionId: 'sess-1',
      content: 'continue',
      cwd: '/tmp/proj',
      timeoutMs: 2000,
    });

    // The turn completed on the NEW id, not the pre-remap one the drive
    // originally subscribed under — proof the collector followed the remap
    // instead of timing out on the abandoned subscription.
    expect(result.outcome).toBe('done');
    expect(result.canonicalId).toBe('sess-1-remapped');
    expect(result.frames.map((f) => f.event)).toEqual([
      'snapshot',
      'turn_start',
      'text_delta',
      'turn_end',
    ]);
    // Both the pre-remap and the re-subscribed /events connections were torn
    // down — the abandoned one is not leaked.
    expect(destroySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not time out on remap: the turn resolves well inside the per-turn budget', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startRemapFakeServer(runtime, 'sess-2-remapped');

    const start = Date.now();
    const result = await driveTurn({
      baseUrl,
      sessionId: 'sess-2',
      content: 'continue',
      cwd: '/tmp/proj',
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - start;

    expect(result.outcome).toBe('done');
    // A driver that fell back to the stale subscription would burn the whole
    // 5000ms turn timeout instead of resolving promptly off the remap.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('driveWidgetAction', () => {
  it('POSTs the widget action to /ui-action (with the injected cwd) and collects the resulting turn', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'ack' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startFakeServer(runtime);

    const result = await driveWidgetAction({
      baseUrl,
      sessionId: 'sess-w',
      cwd: '/tmp/proj',
      action: { actionId: 'confirm', payload: { choice: 'yes' }, widgetTitle: 'Probe' },
    });

    expect(result.outcome).toBe('done');
    expect(result.canonicalId).toBe('sess-w');
    expect(result.frames.map((f) => f.event)).toEqual([
      'snapshot',
      'turn_start',
      'text_delta',
      'turn_end',
    ]);
    // It hit the ui-action endpoint, forwarding the action plus the drive cwd.
    expect(capturedPost?.path).toBe('/api/sessions/sess-w/ui-action');
    expect(capturedPost?.body).toMatchObject({
      actionId: 'confirm',
      cwd: '/tmp/proj',
      payload: { choice: 'yes' },
    });
  });

  it('throws a DriveError on a 409 SESSION_LOCKED', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([async function* () {}]);
    const baseUrl = await startFakeServer(runtime, { lockCode: 409 });

    await expect(
      driveWidgetAction({
        baseUrl,
        sessionId: 's',
        cwd: '/tmp',
        action: { actionId: 'x' },
        timeoutMs: 500,
      })
    ).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
  });
});

describe('driveConversation', () => {
  it('runs each prompt as a turn in order, threading the canonical id, and collects every turn', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'one' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* () {
        yield { type: 'text_delta', data: { text: 'two' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startFakeServer(runtime);

    const result = await driveConversation({
      baseUrl,
      sessionId: 'sess-multi',
      cwd: '/tmp/proj',
      prompts: ['first', 'second'],
    });

    expect(result.outcome).toBe('done');
    expect(result.canonicalId).toBe('sess-multi');
    // Both turns were driven and collected: two turn boundaries end-to-end.
    expect(result.frames.filter((f) => f.event === 'turn_start')).toHaveLength(2);
    expect(result.frames.filter((f) => f.event === 'turn_end')).toHaveLength(2);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('stops early when a turn does not end `done`, leaving later prompts undriven', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'stuck' } } as StreamEvent;
        await new Promise(() => {}); // never yields done → the turn times out
      },
      async function* () {
        yield { type: 'text_delta', data: { text: 'never' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startFakeServer(runtime);

    const result = await driveConversation({
      baseUrl,
      sessionId: 'sess-stop',
      cwd: '/tmp/proj',
      prompts: ['first', 'second'],
      timeoutMs: 150,
    });

    expect(result.outcome).toBe('timeout');
    // Only the first turn ran; the loop broke before the second prompt.
    expect(result.frames.filter((f) => f.event === 'turn_start')).toHaveLength(1);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});
