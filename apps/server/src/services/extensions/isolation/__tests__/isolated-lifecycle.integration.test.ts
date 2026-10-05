/**
 * What happens when an isolated child misbehaves (DOR-2686 task 3.5), against
 * real child processes: a hang is killed as unresponsive, a heap death is
 * told apart from a crash, a crash is a crash, a chatty child cannot flood the
 * log, and a malformed, oversized or flooding channel is dropped rather than
 * acted on. DorkOS (this test process) keeps running through all of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IsolatedExit } from '../isolated-host.js';
import {
  cleanup,
  createHarness,
  makeHost,
  probe,
  startOk,
  type Harness,
} from './isolation-harness.js';

/** Resolve with the first exit a host reports. */
function exitOf(): { onExit: (exit: IsolatedExit) => void; exited: Promise<IsolatedExit> } {
  let onExit: (exit: IsolatedExit) => void = () => {};
  const exited = new Promise<IsolatedExit>((resolve) => {
    onExit = resolve;
  });
  return { onExit: (exit) => onExit(exit), exited };
}

describe('isolated child failures (real child processes)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await cleanup(h);
  });

  // Purpose: the watchdog with the spec's own timings (ping 5 s, pong 15 s)
  // kills a child stuck in a synchronous loop within 20 s, as unresponsive.
  it('kills a hung child as unresponsive within 20 s', async () => {
    const { onExit, exited } = exitOf();
    const host = makeHost(h, { onExit });
    await startOk(host);
    const started = Date.now();
    await host.probe('hang');
    const exit = await exited;
    expect(exit.reason).toBe('server_unresponsive');
    expect(Date.now() - started).toBeLessThan(20_500);
    expect(host.running).toBe(false);
  }, 30_000);

  // Purpose: a responsive child is never killed by the watchdog (short
  // timings, several intervals): the kill above is about the hang.
  it('leaves a responsive child alone', async () => {
    const { onExit } = exitOf();
    const exits: IsolatedExit[] = [];
    const host = makeHost(h, {
      onExit: (e) => {
        exits.push(e);
        onExit(e);
      },
      overrides: {
        timings: { pingIntervalMs: 100, pongTimeoutMs: 500 },
        testSeams: { probes: true },
      },
    });
    await startOk(host);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(host.running).toBe(true);
    expect(exits).toEqual([]);
  });

  // Purpose: limits.memoryMb is a real heap cap, and dying at it reads as
  // out of memory, not as an ordinary crash.
  it('reports a heap death at memoryMb as out of memory', async () => {
    const { onExit, exited } = exitOf();
    const host = makeHost(h, { memoryMb: 64, onExit });
    await startOk(host);
    await host.probe('oom');
    expect((await exited).reason).toBe('server_out_of_memory');
  }, 30_000);

  // Purpose: printing V8's marker and exiting is a crash, not out of memory:
  // the reason follows how the process actually died.
  it('does not take a printed marker for out of memory', async () => {
    const { onExit, exited } = exitOf();
    const host = makeHost(h, { onExit });
    await startOk(host);
    await host.probe('fakeOom');
    expect((await exited).reason).toBe('server_crashed');
  });

  // Purpose: an abort is a crash, and it ends only the child.
  it('reports an abort as a crash', async () => {
    const { onExit, exited } = exitOf();
    const host = makeHost(h, { onExit });
    await startOk(host);
    await host.probe('crash');
    const exit = await exited;
    expect(exit.reason).toBe('server_crashed');
    expect(exit.signal ?? exit.code).not.toBeNull();
  });

  // Purpose: at most 200 lines per window reach the log, then one
  // "output suppressed" line.
  it('caps forwarded output', async () => {
    const host = makeHost(h, { id: 'chatty' });
    await startOk(host);
    await probe(host, 'flood', 1_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const forwarded = h.logs.filter((l) => l.message.startsWith('[ext:chatty] line'));
    expect(forwarded).toHaveLength(200);
    expect(h.logs.filter((l) => l.message === '[ext:chatty] output suppressed')).toHaveLength(1);
  });

  // Purpose: the host reads nothing it has not checked: a malformed message
  // and one over 4 MB are dropped (and logged), and the child keeps running.
  it('drops malformed and oversized messages', async () => {
    const host = makeHost(h, { id: 'noisy' });
    await startOk(host);
    await probe(host, 'sendRaw', { type: 'nope' });
    await probe(host, 'sendRaw', { type: 'run-spawn', rid: 'x' });
    await probe(host, 'sendBig', 5 * 1024 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.logs.filter((l) => l.message.includes('dropped a malformed message'))).toHaveLength(2);
    expect(h.logs.some((l) => l.message.includes('dropped a message over'))).toBe(true);
    expect(host.running).toBe(true);
    expect(await probe(host, 'argvFlags')).toMatchObject({ ok: true });
  });

  // Purpose: a child flooding the channel has the excess dropped within the
  // second, once logged, and is not killed for it (anything it sent past the
  // cap, its own replies included, is lost: that is its own doing).
  it('drops a message flood past the per-second cap', async () => {
    const host = makeHost(h, { id: 'flood' });
    await startOk(host);
    // Not awaited: its own reply arrives after the flood and is dropped with it.
    void host.probe('floodMessages', 20_000).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(h.logs.filter((l) => l.message.includes('too many messages'))).toHaveLength(1);
    expect(host.running).toBe(true);
  });
});
