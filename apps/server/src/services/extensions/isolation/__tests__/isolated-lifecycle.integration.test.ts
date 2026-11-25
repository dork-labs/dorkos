/**
 * What happens when an isolated child misbehaves (DOR-2686 task 3.5), against
 * real child processes: a hang is killed as unresponsive, a heap death is
 * told apart from a crash, a crash is a crash, a chatty child cannot flood the
 * log, and a malformed, oversized or flooding channel is dropped rather than
 * acted on. DorkOS (this test process) keeps running through all of it.
 */
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';
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

/** Block this process's event loop for `ms`, as a busy DorkOS would. */
function stallHost(ms: number): void {
  // Block this event loop without burning a core on the shared machine.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait until the child answers a probe sent after everything it has already
 * been asked to send. The channel is ordered, so one answer proves every
 * earlier message from the child has been read (and kept or dropped). A probe
 * whose answer lands in a second that is already over the cap is dropped, so
 * this keeps asking until one gets through.
 *
 * @param host - A started host.
 * @param budgetMs - How long to keep asking.
 * @returns How long it took, in milliseconds.
 */
async function drained(host: ReturnType<typeof makeHost>, budgetMs: number): Promise<number> {
  const started = Date.now();
  let answered = false;
  while (!answered) {
    if (Date.now() - started > budgetMs) {
      throw new Error(`the child did not answer a probe within ${budgetMs} ms`);
    }
    void host.probe('argvFlags').then(
      () => {
        answered = true;
      },
      () => {}
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Date.now() - started;
}

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

  // Purpose: the watchdog kills a real child stuck in a synchronous loop, as
  // unresponsive, within one ping and one pong timeout. Short timings: the
  // spec's own (ping 5 s, pong 15 s) are walked on a fake clock in
  // watchdog.test.ts, so this real-process half need not wait 20 s.
  it('kills a hung child as unresponsive within a ping and a pong timeout', async () => {
    const { onExit, exited } = exitOf();
    const host = makeHost(h, {
      onExit,
      overrides: {
        timings: { pingIntervalMs: 100, pongTimeoutMs: 500 },
        testSeams: { probes: true },
      },
    });
    await startOk(host);
    const started = Date.now();
    await host.probe('hang');
    const exit = await exited;
    expect(exit.reason).toBe('server_unresponsive');
    expect(Date.now() - started).toBeLessThan(loadCeilingMs(2_000));
    expect(host.running).toBe(false);
  });

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

  // DOR-4785: DorkOS's own event loop stalling (a long synchronous job, a busy
  // machine) is not the child hanging. People and Flow were killed this way
  // about 90 times in a day. The stall here is real: this process blocks.
  it('does not kill a healthy child when DorkOS itself stalls past the pong timeout', async () => {
    const exits: IsolatedExit[] = [];
    const host = makeHost(h, {
      onExit: (e) => exits.push(e),
      overrides: {
        timings: { pingIntervalMs: 100, pongTimeoutMs: 500 },
        testSeams: { probes: true },
      },
    });
    await startOk(host);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Observe the real IPC channel without changing the child's behavior.
    const child = host['child'];
    if (!child) throw new Error('The healthy child did not start.');
    const messages: unknown[] = [];
    child.on('message', (message) => messages.push(message));
    const lastPing = host['pingCount'];
    stallHost(1_500);
    // This sequence number was not sent before the stall. A real watchdog
    // ping and its matching pong must cross the pipe after DorkOS resumes.
    await expect.poll(() => messages).toContainEqual({ type: 'pong', n: lastPing + 1 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(exits).toEqual([]);
    expect(host.running).toBe(true);
  });

  // DOR-4785: crediting DorkOS's stall never shields a child that is really stuck.
  it('still kills a hung child when DorkOS stalls as well', async () => {
    const { onExit, exited } = exitOf();
    const host = makeHost(h, {
      onExit,
      overrides: {
        timings: { pingIntervalMs: 100, pongTimeoutMs: 500 },
        testSeams: { probes: true },
      },
    });
    await startOk(host);
    await host.probe('hang');
    stallHost(1_500);
    const after = Date.now();
    const exit = await exited;
    expect(exit.reason).toBe('server_unresponsive');
    expect(Date.now() - after).toBeLessThan(3_000);
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
  //
  // It waits for the flood to be READ rather than for a fixed time: on a slow
  // runner (the Windows CI leg) 20,000 messages are not all through the pipe
  // after half a second, and the old fixed sleep read an empty log (DOR-4888).
  // A slow pipe can also spread the flood over more than one second, and each
  // second over the cap logs once, so the bound is one line per second it took.
  it(
    'drops a message flood past the per-second cap',
    async () => {
      const host = makeHost(h, { id: 'flood' });
      await startOk(host);
      // Not awaited: its own reply arrives after the flood and is dropped with it.
      void host.probe('floodMessages', 20_000).catch(() => {});
      const tookMs = await drained(host, loadScaledMs(10_000));
      const warnings = h.logs.filter((l) => l.message.includes('too many messages'));
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings.length).toBeLessThanOrEqual(Math.ceil(tookMs / 1_000) + 1);
      expect(host.running).toBe(true);
    },
    Math.min(60_000, loadCeilingMs(12_000))
  );
});
