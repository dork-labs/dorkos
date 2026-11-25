/**
 * Drive loop: POST-trigger a turn and collect it off the durable `/events`
 * stream to its terminal `turn_end`. Driven against a `FakeAgentRuntime`
 * scenario streamed through an in-process server that honors the trigger-only
 * contract (202 + subscribe-first delivery, ADR-0264). Pins: the subscribe→POST
 * →collect loop, the `turn_end` terminator, a `409 SESSION_LOCKED` runner error,
 * the timeout guard, and the live abort guard.
 * Hardening pin (PR #331): the `/events` GET is destroyed on every exit path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { driveTurn, driveConversation, driveWidgetAction, DriveError } from '../drive.js';

let server: http.Server | undefined;
/** The last trigger POST the fake server received (path + parsed body + headers). */
let capturedPost: { path: string; body: unknown; headers: http.IncomingHttpHeaders } | undefined;

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
        capturedPost = {
          path: url.pathname,
          body: body ? JSON.parse(body) : undefined,
          headers: req.headers,
        };
        if (opts.lockCode) {
          res.writeHead(opts.lockCode, { 'Content-Type': 'application/problem+json' });
          res.end(JSON.stringify({ status: opts.lockCode, code: 'session_locked' }));
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
          sink.write(sse('turn_end', { type: 'turn_end', seq }));
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

/** The seq space a rekeying fake server stamps its frame ids from. */
const FAKE_EPOCH = 1_700_000_000_000;

/** Build the durable stream's frame id: `<resourceId>-<epoch>-<generation>-<seq>`. */
function frameId(resourceId: string, seq: number): string {
  return `${resourceId}-${FAKE_EPOCH}-g0-${seq}`;
}

/** Serialize one durable SessionEvent with its `id:` line, the way the server does. */
function idSse(resourceId: string, seq: number, event: string, data: object): string {
  return `id: ${frameId(resourceId, seq)}\nevent: ${event}\ndata: ${JSON.stringify({ type: event, seq, ...data })}\n\n`;
}

/**
 * The resume cursor a `/events` request carries, parsed the way the real route
 * parses it: `Last-Event-ID` first, then the `?after=` integer. Returns
 * `undefined` for a cold connect.
 *
 * Deliberately does NOT require the cursor to name the id being subscribed —
 * that is the real route's behaviour too (`routes/session-events-handler.ts`),
 * and it is the whole reason a rekeyed session can resume its own seq space.
 */
function parseResume(req: http.IncomingMessage, url: URL): number | undefined {
  const header = req.headers['last-event-id'];
  if (typeof header === 'string' && header !== '') {
    const match = /-(\d+)-g\d+-(\d+)$/.exec(header);
    if (match && Number(match[1]) === FAKE_EPOCH) return Number(match[2]);
    return undefined;
  }
  const after = url.searchParams.get('after');
  if (after !== null && after !== '' && Number.isInteger(Number(after))) return Number(after);
  return undefined;
}

/** What a {@link startRekeyingServer} run should do to the FIRST, pre-rekey connection. */
interface RekeyServerOptions {
  /** The canonical id the 202 reports, different from the one the caller subscribed under. */
  remappedId: string;
}

/**
 * A fake server that simulates claude-code re-minting its internal session id
 * mid-turn (DOR-397) over a DURABLE stream that honours a resume cursor.
 *
 * The trigger POST's 202 body reports `remappedId` — a different id than the one
 * the caller subscribed under — and the turn's frames stream onto a `/events`
 * connection opened under `remappedId`, never the pre-rekey id. Both ids are
 * served by ONE seq space, which is what a rekeyed projector is (ADR-0267).
 *
 * The two halves that make this a real test of the resume, not just of the swap:
 *
 * - a COLD connect gets a `snapshot` whose `cursor` is the highest seq ingested
 *   so far and NO replay of the events behind it — history as state, exactly
 *   like the real stream, which is what makes a cold re-subscribe lossy;
 * - a RESUMED connect gets no snapshot and a replay of every stored event above
 *   the cursor, then goes live.
 */
async function startRekeyingServer(
  runtime: FakeAgentRuntime,
  opts: RekeyServerOptions
): Promise<string> {
  const live = new Map<string, http.ServerResponse>();
  /** The one seq space both ids share: everything ingested, in order. */
  const ingested: { seq: number; wire: string }[] = [];
  let seq = 0;
  /**
   * Append one event to the shared seq space and return its wire text.
   *
   * `resourceId` is the id the frame is STAMPED with — the pre-rekey connection's
   * frames name the pre-rekey id, exactly as the real server stamps them, so a
   * cursor echoed back from one of them names an id this subscription no longer
   * uses. Resuming anyway is the property under test.
   */
  const ingest = (event: string, resourceId = opts.remappedId): string => {
    seq += 1;
    const wire = idSse(resourceId, seq, event, {});
    ingested.push({ seq, wire });
    return wire;
  };
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
      const resume = parseResume(req, url);
      if (resume === undefined) {
        // Cold: state, not history. The events behind the cursor are NOT replayed.
        res.write(sse('snapshot', { cursor: seq, status: { lifecycle: 'idle' } }));
      } else {
        for (const entry of ingested) if (entry.seq > resume) res.write(entry.wire);
      }
      live.set(sessionId, res);
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        capturedPost = {
          path: url.pathname,
          body: body ? JSON.parse(body) : undefined,
          headers: req.headers,
        };
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionId: opts.remappedId }));
        // Then stream the rest onto the REMAPPED id's connection only.
        void (async () => {
          const sink = await waitForSink(opts.remappedId);
          sink.write(ingest('turn_start'));
          for await (const ev of runtime.sendMessage(opts.remappedId, 'x', {})) {
            const projected = projectEvent(ev as StreamEvent, seq + 1);
            if (projected) {
              seq += 1;
              ingested.push({ seq, wire: projected });
              sink.write(projected);
            }
          }
          sink.write(ingest('turn_end'));
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
    const baseUrl = await startRekeyingServer(runtime, { remappedId: 'sess-1-remapped' });
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

  it('sends X-Client-Id on the /ui-action POST when a clientId is given (DOR-1228)', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startFakeServer(runtime);

    await driveWidgetAction({
      baseUrl,
      sessionId: 'sess-w2',
      cwd: '/tmp/proj',
      action: { actionId: 'confirm' },
      clientId: 'client-abc',
    });

    expect(capturedPost?.headers['x-client-id']).toBe('client-abc');
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
});

describe('onFrames — the live observer the approval driver rides (DOR-498)', () => {
  it('sees frames WHILE the turn runs, not only after it ends', async () => {
    // The whole point: an approval prompt has to be answered mid-turn. An
    // observer that only fired at the end would answer a turn that had already
    // died on the harness timeout.
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield {
          type: 'approval_required',
          data: { toolCallId: 'tc1', toolName: 'mcp__dorkos__marketplace_uninstall', input: '{}' },
        } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'waiting' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startFakeServer(runtime);

    /** Every observation, recorded as (frame count, whether the turn had ended). */
    const observations: Array<{ count: number; ended: boolean; sessionId: string }> = [];
    const result = await driveTurn({
      baseUrl,
      sessionId: 'sess-observe',
      content: 'Uninstall it',
      cwd: '/tmp/proj',
      onFrames: (frames, sessionId) => {
        observations.push({
          count: frames.length,
          ended: frames.some((f) => f.event === 'turn_end'),
          sessionId,
        });
      },
    });

    expect(result.outcome).toBe('done');
    expect(observations.length).toBeGreaterThan(1);
    // At least one observation happened with the approval prompt present and the
    // turn still open — the window in which an answer would actually help.
    expect(observations.some((o) => !o.ended)).toBe(true);
    expect(observations.every((o) => o.sessionId === 'sess-observe')).toBe(true);
  });
});
