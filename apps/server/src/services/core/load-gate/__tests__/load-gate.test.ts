/**
 * The load gate's wait (DOR-4209), over a real temp folder with a fake load,
 * a fake clock and a sleep the test steps by hand. Every queue a test opens on
 * the folder shares that clock, because heartbeats are file times stamped by it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadGateSettings } from '@dorkos/shared/config-schema';
import { createLoadGate, type BusyStatus, type HeldSlot, type WaitStatus } from '../load-gate.js';
import { fixedLoadSource } from '../load-source.js';
import { prepareDir } from '../queue-folder.js';
import { TicketQueue } from '../ticket-queue.js';

const MINUTE = 60_000;
const POLL = 5_000;

let dir: string;
let settings: LoadGateSettings;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-load-gate-wait-'));
  settings = {
    enabled: true,
    maxLoad: 16,
    slots: 1,
    maxWaitMinutes: 60,
    hardCapMinutes: 240,
    heavyCommands: { add: [], remove: [] },
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Let every waiter finish the synchronous check it is in and go back to sleep. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock and a sleep that only move when the test says. */
function steppedTime() {
  let now = Date.UTC(2026, 10, 18, 12);
  let wakers: (() => void)[] = [];
  return {
    now: () => now,
    sleep: (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        wakers.push(resolve);
        signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), {
          once: true,
        });
      }),
    /** Move the clock on and wake every sleeper once. */
    async step(ms: number) {
      now += ms;
      const waking = wakers;
      wakers = [];
      for (const wake of waking) wake();
      await settle();
    },
  };
}

function setup(load = 20) {
  const time = steppedTime();
  const loadSource = fixedLoadSource(load);
  const lines: string[] = [];
  const gate = createLoadGate({
    config: () => settings,
    dir,
    loadSource,
    now: time.now,
    sleep: time.sleep,
    pollMs: POLL,
    noticeEveryMs: MINUTE,
    log: (line) => lines.push(line),
  });
  return { gate, time, loadSource, lines, queue: new TicketQueue({ dir, now: time.now }) };
}

/** Track a wait's result without awaiting it. */
function track(wait: Promise<HeldSlot | null>) {
  const state: { slot?: HeldSlot | null; error?: unknown } = {};
  wait.then(
    (slot) => (state.slot = slot),
    (error: unknown) => (state.error = error)
  );
  return state;
}

describe('waitForSlot', () => {
  it('holds two jobs while the machine is busy, then lets them run one at a time, first come first', async () => {
    const { gate, time, loadSource, queue } = setup(20);
    const aSeen: WaitStatus[] = [];
    const bSeen: WaitStatus[] = [];
    const a = track(gate.waitForSlot({ job: 'pnpm' }, { onWait: (s) => void aSeen.push(s) }));
    const b = track(gate.waitForSlot({ job: 'tsc' }, { onWait: (s) => void bSeen.push(s) }));
    await settle();

    expect(aSeen[0]).toEqual({
      position: 1,
      aheadCount: 0,
      load: 20,
      maxLoad: 16,
      waitedMs: 0,
      pastMaxWait: false,
    });
    expect(bSeen[0]).toMatchObject({ position: 2, aheadCount: 1 });
    // Counts only: nothing about which agents are ahead or what they run.
    expect(Object.keys(bSeen[0]!).sort()).toEqual(
      ['aheadCount', 'load', 'maxLoad', 'pastMaxWait', 'position', 'waitedMs'].sort()
    );

    await time.step(POLL);
    expect(a.slot).toBeUndefined();
    expect(b.slot).toBeUndefined();

    loadSource.set(4);
    await time.step(POLL);
    expect(a.slot).toMatchObject({ outcome: 'ran', waitedMs: 2 * POLL });
    expect(b.slot).toBeUndefined();

    await time.step(POLL);
    expect(b.slot).toBeUndefined();
    a.slot!.release();
    await time.step(POLL);
    expect(b.slot).toMatchObject({ outcome: 'ran', waitedMs: 4 * POLL });
    b.slot!.release();
    expect(queue.runningCount()).toBe(0);
  });

  it('runs the job anyway at the hard cap, and logs only its program', async () => {
    settings.maxWaitMinutes = 1;
    settings.hardCapMinutes = 3;
    const { gate, time, lines, queue } = setup(20);
    const wait = track(gate.waitForSlot({ job: 'pnpm' }));
    await settle();
    await time.step(2 * MINUTE);
    expect(wait.slot).toBeUndefined();
    await time.step(MINUTE);
    expect(wait.slot).toMatchObject({ outcome: 'hard-cap', waitedMs: 3 * MINUTE });
    expect(queue.runningCount()).toBe(1);
    expect(lines).toEqual(['[LoadGate] A pnpm job ran after waiting 3 min, the hard cap']);
    wait.slot!.release();
    expect(queue.runningCount()).toBe(0);
  });

  it('runs a job a person lets through at once, past a busy machine and a full slot', async () => {
    const { gate, time, queue } = setup(4);
    const first = track(gate.waitForSlot({ job: 'pnpm' }));
    await settle();
    expect(first.slot?.outcome).toBe('ran');
    const busyGate = createLoadGate({
      config: () => settings,
      dir,
      loadSource: fixedLoadSource(99),
      now: time.now,
      sleep: time.sleep,
    });
    const waiting = track(busyGate.waitForSlot({ job: 'tsc' }));
    await settle();
    expect(waiting.slot).toBeUndefined();
    const [ticket] = queue.list();
    expect(queue.markLetThrough(ticket!.id)).toBe(true);
    await time.step(POLL);
    expect(waiting.slot?.outcome).toBe('let-through');
    expect(queue.runningCount()).toBe(2);
  });

  it('takes its ticket out of line when the wait is stopped', async () => {
    const { gate, queue } = setup(20);
    const controller = new AbortController();
    const wait = track(gate.waitForSlot({ job: 'pnpm' }, { signal: controller.signal }));
    await settle();
    expect(queue.list()).toHaveLength(1);
    controller.abort();
    await settle();
    expect((wait.error as DOMException).name).toBe('AbortError');
    expect(queue.list()).toEqual([]);
  });

  it('does not wait at all when the gate is off', async () => {
    settings.enabled = false;
    const { gate, queue } = setup(99);
    await expect(gate.waitForSlot({ job: 'pnpm' })).resolves.toMatchObject({
      outcome: 'ran',
      waitedMs: 0,
    });
    expect(queue.list()).toEqual([]);
  });
});

describe('a running job’s heartbeat', () => {
  // Only the slot's own interval is faked; the stepped clock and setImmediate stay as they are.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The held slot's file time, as the folder has it. */
  const slotTime = (): number => fs.statSync(path.join(dir, 'slot-0.json')).mtimeMs;

  it('beats every poll, and stops when the job is released', async () => {
    const { gate, time } = setup(4);
    const held = track(gate.waitForSlot({ job: 'pnpm' }));
    await settle();
    expect(held.slot?.outcome).toBe('ran');
    expect(vi.getTimerCount()).toBe(1);

    await time.step(POLL);
    vi.advanceTimersByTime(POLL);
    expect(Math.abs(slotTime() - time.now())).toBeLessThan(1_000);

    held.slot!.release();
    expect(vi.getTimerCount()).toBe(0);
    expect(held.slot!.heartbeat()).toBe(false);
  });
});

describe('when the shared folder fails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets two jobs run one after the other in this server’s own line, logging once', async () => {
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (String(file).startsWith(dir)) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      return (realWrite as (...args: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync);
    const { gate, time, lines } = setup(4);
    const bSeen: WaitStatus[] = [];
    const a = track(gate.waitForSlot({ job: 'pnpm' }));
    const b = track(gate.waitForSlot({ job: 'tsc' }, { onWait: (s) => void bSeen.push(s) }));
    await settle();
    expect(a.slot?.outcome).toBe('gate-error');
    expect(b.slot).toBeUndefined();
    expect(bSeen[0]).toMatchObject({ position: 1, aheadCount: 0 });

    await time.step(POLL);
    expect(b.slot).toBeUndefined();
    a.slot!.release();
    await time.step(POLL);
    expect(b.slot?.outcome).toBe('gate-error');
    expect(lines).toEqual([
      "[LoadGate] The shared load-gate queue could not be used; heavy jobs wait in this server's own line, one at a time (ENOSPC)",
    ]);
  });

  // Making a link on Windows needs a privilege a test runner may not have.
  it.skipIf(process.platform === 'win32')(
    'refuses a queue folder that is a link to a folder this user owns, and waits here instead',
    async () => {
      const target = path.join(dir, 'real');
      const link = path.join(dir, 'link');
      fs.mkdirSync(target, { mode: 0o700 });
      fs.symlinkSync(target, link);
      expect(() => prepareDir(link)).toThrow(/not a plain folder/);

      const lines: string[] = [];
      const gate = createLoadGate({
        config: () => settings,
        dir: link,
        loadSource: fixedLoadSource(4),
        log: (line) => lines.push(line),
      });
      await expect(gate.waitForSlot({ job: 'pnpm' })).resolves.toMatchObject({
        outcome: 'gate-error',
      });
      expect(lines).toEqual([
        "[LoadGate] The shared load-gate queue could not be used; heavy jobs wait in this server's own line, one at a time (Error)",
      ]);
      // Nothing was written through the link.
      expect(fs.readdirSync(target)).toEqual([]);
    }
  );

  it('never writes command text, even when a caller passes it as the label', async () => {
    const { gate, lines } = setup(4);
    const slot = await gate.waitForSlot({ job: 'pnpm build --filter made-up-secret-name' });
    expect(slot.outcome).toBe('gate-error');
    expect(lines).toEqual([
      "[LoadGate] The shared load-gate queue could not be used; heavy jobs wait in this server's own line, one at a time (TypeError)",
    ]);
    expect(fs.readdirSync(dir).join('\n')).not.toContain('made-up-secret-name');
  });
});

describe('who a job is for', () => {
  it('stays in this server’s memory, for the person’s list, and never reaches the folder', async () => {
    const { gate } = setup(99);
    track(
      gate.waitForSlot({ job: 'pnpm', agentName: 'Made Up', chatId: 'chat-1', chatTitle: 'A chat' })
    );
    await settle();
    expect(gate.waitingJobs()).toEqual([
      expect.objectContaining({
        job: 'pnpm',
        agentName: 'Made Up',
        chatId: 'chat-1',
        chatTitle: 'A chat',
      }),
    ]);
    const onDisk = fs
      .readdirSync(dir)
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
      .join('\n');
    expect(onDisk).not.toMatch(/Made Up|chat-1|A chat/);
  });
});

describe('gateIfHeavy', () => {
  it('queues a heavy command under its program name alone', async () => {
    const { gate, queue } = setup(99);
    const wait = track(gate.gateIfHeavy('pnpm exec tsc -p /made/up/project', { chatId: 'c1' }));
    await settle();
    expect(queue.list().map((ticket) => ticket.job)).toEqual(['tsc']);
    expect(gate.waitingJobs().map((job) => job.chatId)).toEqual(['c1']);
    expect(wait.slot).toBeUndefined();
  });
});

describe('occupy: a heavy job already running counts at once (DOR-4743)', () => {
  it('makes the next heavy job wait behind it until it ends', async () => {
    const { gate, time } = setup(4);
    const running = gate.occupy('pnpm build')!;
    const next = track(gate.waitForSlot({ job: 'tsc' }));
    await settle();
    await time.step(POLL);
    expect(next.slot).toBeUndefined();
    running.release();
    await time.step(POLL);
    expect(next.slot?.outcome).toBe('ran');
    next.slot!.release();
  });

  it('shares one slot among one thread’s running jobs, given back with the last', () => {
    const { gate, queue } = setup(99);
    const build = gate.occupy('pnpm build', { shareKey: 'codex:c1:running' })!;
    const test = gate.occupy('pnpm test', { shareKey: 'codex:c1:running' })!;
    expect(queue.runningCount()).toBe(1);
    build.release();
    expect(queue.runningCount()).toBe(1);
    test.release();
    expect(queue.runningCount()).toBe(0);
  });
});

describe('waitWhileBusy (DOR-4743)', () => {
  /** Track a busy-wait without awaiting it. */
  function trackWait(wait: Promise<void>) {
    const state: { done: boolean; error?: unknown } = { done: false };
    wait.then(
      () => (state.done = true),
      (error: unknown) => (state.error = error)
    );
    return state;
  }

  it('waits while both hold, says so every minute, and returns once either stops', async () => {
    const { gate, time, loadSource } = setup(20);
    let running = true;
    const seen: BusyStatus[] = [];
    const wait = trackWait(gate.waitWhileBusy(() => running, { onWait: (s) => void seen.push(s) }));
    await settle();
    expect(seen).toEqual([{ load: 20, maxLoad: 16, waitedMs: 0 }]);
    await time.step(MINUTE);
    expect(wait.done).toBe(false);
    expect(seen).toHaveLength(2);
    running = false;
    await time.step(POLL);
    expect(wait.done).toBe(true);

    running = true;
    const again = trackWait(gate.waitWhileBusy(() => running));
    await settle();
    expect(again.done).toBe(false);
    loadSource.set(4);
    await time.step(POLL);
    expect(again.done).toBe(true);
  });

  it('gives up at maxWaitMinutes, not the hard cap: what waits here is a person’s reply', async () => {
    const { gate, time, lines } = setup(20);
    const wait = trackWait(gate.waitWhileBusy(() => true));
    await settle();
    await time.step(59 * MINUTE);
    expect(wait.done).toBe(false);
    await time.step(MINUTE);
    expect(wait.done).toBe(true);
    expect(lines).toEqual(['[LoadGate] Work started after waiting 60 min, the longest it waits']);
  });
});
