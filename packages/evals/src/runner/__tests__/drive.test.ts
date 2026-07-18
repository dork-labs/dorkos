/**
 * Drive loop: POST-trigger a turn and collect it off the durable `/events`
 * stream to its terminal `turn_end`. Driven against a `FakeAgentRuntime`
 * scenario streamed through an in-process server that honors the trigger-only
 * contract (202 + subscribe-first delivery, ADR-0264). Pins: the subscribe→POST
 * →collect loop, the `turn_end` terminator, a `409 SESSION_LOCKED` runner error,
 * the timeout guard, and the live abort guard.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { driveTurn, DriveError } from '../drive.js';

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

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

    if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
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
  it('POST→collect→terminal turn_end, returning the canonical id and ordered frames', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'Hi' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const baseUrl = await startFakeServer(runtime);

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

  it('throws a DriveError on a 409 SESSION_LOCKED (a runner error, not an eval failure)', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([async function* () {}]);
    const baseUrl = await startFakeServer(runtime, { lockCode: 409 });

    await expect(
      driveTurn({ baseUrl, sessionId: 's', content: 'go', cwd: '/tmp', timeoutMs: 500 })
    ).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    await expect(
      driveTurn({ baseUrl, sessionId: 's', content: 'go', cwd: '/tmp', timeoutMs: 500 })
    ).rejects.toBeInstanceOf(DriveError);
  });

  it('resolves `timeout` when the turn never reaches turn_end', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'partial' } } as StreamEvent;
        await new Promise(() => {}); // never yields done
      },
    ]);
    const baseUrl = await startFakeServer(runtime);

    const result = await driveTurn({
      baseUrl,
      sessionId: 's',
      content: 'go',
      cwd: '/tmp',
      timeoutMs: 150,
    });
    expect(result.outcome).toBe('timeout');
  });

  it('stops with `aborted` when the live abort guard trips (budget ceiling)', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'session_status', data: { costUsd: 5 } } as StreamEvent;
        await new Promise(() => {}); // keep streaming; abort must stop us
      },
    ]);
    const baseUrl = await startFakeServer(runtime);

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
  });
});
