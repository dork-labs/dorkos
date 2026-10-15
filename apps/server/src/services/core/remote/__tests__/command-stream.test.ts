/**
 * The managed remote access command stream (DOR-2086) against a fake
 * event-stream server: strict parsing, reconnects that honour `retry:` and
 * back off with full jitter, the silence watchdog, the lease renewal, and
 * cancellation.
 */
import { describe, expect, it, vi } from 'vitest';
import openFixture from '@dork-labs/cloud-api/fixtures/v1/remote/command-open.json' with { type: 'json' };
import keepaliveReconnect from '@dork-labs/cloud-api/fixtures/v1/remote/command-keepalive-reconnect.json' with { type: 'json' };

import {
  COMMAND_LEASE_MS,
  CommandStream,
  DEFAULT_RETRY_MS,
  KEEPALIVE_WATCHDOG_MS,
  LEASE_MARGIN_MS,
  MAX_RETRY_MS,
  MIN_BACKOFF_MS,
  type CommandStreamDeps,
} from '../command-stream.js';

/** One fake connection: push text, end it, or break it. */
class FakeConnection {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller;
    },
  });
  cancelled = false;

  constructor(signal: AbortSignal) {
    signal.addEventListener('abort', () => {
      this.cancelled = true;
    });
  }

  push(text: string): void {
    this.controller.enqueue(new TextEncoder().encode(text));
  }

  end(): void {
    this.controller.close();
  }

  fail(): void {
    this.controller.error(new TypeError('socket hang up'));
  }

  response(type = 'text/event-stream'): Response {
    return new Response(this.body, { status: 200, headers: { 'content-type': type } });
  }
}

/** Timers fired by the test, not the clock. */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      next += 1;
      pending.set(next, { fn, ms });
      return next;
    },
    clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    /** Fire the pending timer set for exactly `ms`. */
    fire(ms: number) {
      for (const [id, timer] of pending) {
        if (timer.ms === ms) {
          pending.delete(id);
          timer.fn();
          return true;
        }
      }
      return false;
    },
    delays: () => [...pending.values()].map((timer) => timer.ms),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await tick();
  expect(check()).toBe(true);
}

function harness(overrides: Partial<CommandStreamDeps> = {}) {
  const connections: FakeConnection[] = [];
  const answers: Array<(signal: AbortSignal) => Response | Promise<Response>> = [];
  const commands: unknown[] = [];
  const sleeps: number[] = [];
  const timers = manualTimers();
  let run = true;
  const stream = new CommandStream({
    open: async (signal) => {
      const answer = answers.shift();
      if (answer) return answer(signal);
      const connection = new FakeConnection(signal);
      connections.push(connection);
      return connection.response();
    },
    onCommand: (command) => commands.push(command),
    shouldRun: () => run,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    timers,
    ...overrides,
  });
  return {
    stream,
    connections,
    answers,
    commands,
    sleeps,
    timers,
    halt: () => {
      run = false;
    },
  };
}

describe('CommandStream', () => {
  it('delivers leased commands and ignores what does not parse, logging no body', async () => {
    const h = harness();
    void h.stream.start();
    await until(() => h.connections.length === 1);
    const connection = h.connections[0]!;
    connection.push(`data: ${JSON.stringify(openFixture)}\n\n`);
    connection.push('data: not json\n\n');
    connection.push(`data: ${JSON.stringify({ kind: 'teleport', id: 'x', leaseToken: 'lt' })}\n\n`);
    connection.push(`data: ${JSON.stringify({ ...openFixture, wakeId: 42 })}\n\n`);
    await until(() => h.commands.length === 1);
    expect(h.commands).toEqual([openFixture]);
    h.stream.stop();
  });

  it('keeps keepalives to itself and honours their reconnect wait', async () => {
    const h = harness();
    void h.stream.start();
    await until(() => h.connections.length === 1);
    h.connections[0]!.push(`data: ${JSON.stringify(keepaliveReconnect)}\n\n`);
    await until(() => h.stream.reconnectAfterMs === keepaliveReconnect.reconnectAfterMs);
    expect(h.commands).toEqual([]);
    h.connections[0]!.end();
    await until(() => h.connections.length === 2);
    expect(h.sleeps).toEqual([keepaliveReconnect.reconnectAfterMs]);
    h.stream.stop();
  });

  it('reconnects after a clean end using the server retry, bounded', async () => {
    const h = harness();
    void h.stream.start();
    await until(() => h.connections.length === 1);
    h.connections[0]!.push('retry: 999999\n\n');
    h.connections[0]!.end();
    await until(() => h.connections.length === 2);
    expect(h.sleeps).toEqual([MAX_RETRY_MS]);
    h.stream.stop();
  });

  it('jitters the clean reconnect around the server retry, floored and capped', async () => {
    // Each connection draws once for its lease renewal, then once for the wait.
    const draws = [0.5, 0, 0.5, 0.9, 0.5, 0.99];
    const h = harness({ random: () => draws.shift() ?? 0.5 });
    void h.stream.start();
    for (let n = 1; n <= 3; n += 1) {
      await until(() => h.connections.length === n);
      if (n === 3) h.connections[2]!.push('retry: 50000\n\n');
      h.connections[n - 1]!.end();
    }
    await until(() => h.connections.length === 4);
    // 0 of 10s is floored; 0.9 of 10s is 9s; 0.99 of 100s is capped.
    expect(h.sleeps).toEqual([MIN_BACKOFF_MS, 9000, MAX_RETRY_MS]);
    h.stream.stop();
  });

  it('backs off exponentially with full jitter while connections fail, then resets', async () => {
    const h = harness();
    const refused = () => new Response(null, { status: 503 });
    h.answers.push(refused, refused, refused, () => Promise.reject(new TypeError('offline')));
    void h.stream.start();
    await until(() => h.connections.length === 1);
    // random() is 0.5: half of 5s, 10s, 20s, 40s.
    expect(h.sleeps).toEqual([2500, 5000, 10000, 20000]);
    h.connections[0]!.end();
    await until(() => h.connections.length === 2);
    expect(h.sleeps.at(-1)).toBe(DEFAULT_RETRY_MS);
    h.stream.stop();
  });

  it('treats a response that is not an event stream as a failure', async () => {
    const h = harness();
    h.answers.push(() => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    void h.stream.start();
    await until(() => h.connections.length === 1);
    expect(h.sleeps).toEqual([2500]);
    h.stream.stop();
  });

  it('reconnects when the stream drops mid-read', async () => {
    const h = harness();
    void h.stream.start();
    await until(() => h.connections.length === 1);
    h.connections[0]!.fail();
    await until(() => h.connections.length === 2);
    expect(h.sleeps).toEqual([2500]);
    h.stream.stop();
  });

  it('reconnects after two keepalive intervals of silence, and not before', async () => {
    const h = harness();
    void h.stream.start();
    await until(() => h.connections.length === 1);
    expect(h.timers.delays()).toContain(KEEPALIVE_WATCHDOG_MS);
    h.connections[0]!.push(': ping\n\n');
    await tick();
    // A byte re-arms the watchdog: one pending watchdog, never two.
    expect(h.timers.delays().filter((ms) => ms === KEEPALIVE_WATCHDOG_MS)).toHaveLength(1);
    expect(h.timers.fire(KEEPALIVE_WATCHDOG_MS)).toBe(true);
    await until(() => h.connections.length === 2);
    expect(h.connections[0]!.cancelled).toBe(true);
    expect(h.sleeps).toEqual([2500]);
    h.stream.stop();
  });

  it('renews the connection before the lease runs out', async () => {
    const h = harness();
    void h.stream.start();
    await until(() => h.connections.length === 1);
    const renewAt = h.timers.delays().find((ms) => ms !== KEEPALIVE_WATCHDOG_MS)!;
    expect(renewAt).toBeLessThanOrEqual(COMMAND_LEASE_MS - LEASE_MARGIN_MS);
    h.timers.fire(renewAt);
    await until(() => h.connections.length === 2);
    // A renewal is not a failure: the ordinary retry wait, no backoff.
    expect(h.sleeps).toEqual([DEFAULT_RETRY_MS]);
    h.stream.stop();
  });

  it('stops at once, cancelling the connection and any wait', async () => {
    let releaseSleep: (() => void) | undefined;
    const h = harness({
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
          signal.addEventListener('abort', () => resolve());
        }),
    });
    const done = h.stream.start();
    await until(() => h.connections.length === 1);
    h.connections[0]!.end();
    await until(() => releaseSleep !== undefined);
    h.stream.stop();
    await done;
    expect(h.connections).toHaveLength(1);

    const live = harness();
    const finished = live.stream.start();
    await until(() => live.connections.length === 1);
    live.stream.stop();
    await finished;
    expect(live.connections[0]!.cancelled).toBe(true);
    expect(live.timers.pending.size).toBe(0);
  });

  it('stops for good when it no longer belongs, or Cloud does not serve the route', async () => {
    const h = harness();
    void h.stream.start();
    await until(() => h.connections.length === 1);
    h.halt();
    h.connections[0]!.end();
    await until(() => h.stream.stopped);
    expect(h.connections).toHaveLength(1);

    const onAbsent = vi.fn();
    const absent = harness({ onAbsent });
    absent.answers.push(() => new Response(null, { status: 404 }));
    await absent.stream.start();
    expect(onAbsent).toHaveBeenCalledTimes(1);
    expect(absent.connections).toHaveLength(0);
  });
});
