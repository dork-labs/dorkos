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
import { createLoadGate, type HeldSlot, type WaitStatus } from '../load-gate.js';
import { fixedLoadSource } from '../load-source.js';
import { DEFAULT_LEASE_MS, TicketQueue } from '../ticket-queue.js';

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

/** Turn the queue folder into a plain file, so every operation on it fails. */
function breakFolder(): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'not a folder');
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

  it('says once a job has waited past maxWaitMinutes, and keeps it waiting', async () => {
    settings.maxWaitMinutes = 2;
    const { gate, time } = setup(20);
    const seen: WaitStatus[] = [];
    const wait = track(gate.waitForSlot({ job: 'pnpm' }, { onWait: (s) => void seen.push(s) }));
    await settle();
    await time.step(MINUTE);
    await time.step(MINUTE);
    expect(seen.map((s) => [s.waitedMs, s.pastMaxWait])).toEqual([
      [0, false],
      [MINUTE, false],
      [2 * MINUTE, true],
    ]);
    expect(wait.slot).toBeUndefined();
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

  it('reads a hard cap below maxWaitMinutes as maxWaitMinutes', async () => {
    settings.maxWaitMinutes = 3;
    settings.hardCapMinutes = 1;
    const { gate, time } = setup(20);
    const wait = track(gate.waitForSlot({ job: 'pnpm' }));
    await settle();
    await time.step(2 * MINUTE);
    expect(wait.slot).toBeUndefined();
    await time.step(MINUTE);
    expect(wait.slot?.outcome).toBe('hard-cap');
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

  it('refuses at once for a signal already stopped, queueing nothing', async () => {
    const { gate, queue } = setup(20);
    const controller = new AbortController();
    controller.abort();
    await expect(
      gate.waitForSlot({ job: 'pnpm' }, { signal: controller.signal })
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
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

  it('lets a waiting job go when the gate is switched off mid-wait', async () => {
    const { gate, time, queue } = setup(99);
    const wait = track(gate.waitForSlot({ job: 'pnpm' }));
    await settle();
    settings.enabled = false;
    await time.step(POLL);
    expect(wait.slot).toMatchObject({ outcome: 'ran', waitedMs: POLL });
    expect(queue.list()).toEqual([]);
  });
});

describe('a ticket that went missing', () => {
  it('rejoins at its own place and never reports a place it does not have', async () => {
    const { gate, time, queue } = setup(20);
    const aSeen: WaitStatus[] = [];
    track(gate.waitForSlot({ job: 'pnpm' }, { onWait: (s) => void aSeen.push(s) }));
    track(gate.waitForSlot({ job: 'tsc' }));
    await settle();
    const [mine] = queue.list();
    fs.rmSync(
      path.join(
        dir,
        fs.readdirSync(dir).find((name) => name.includes(mine!.id))!
      )
    );
    expect(queue.position(mine!)).toBe(0);

    await time.step(MINUTE);
    expect(queue.list().map((ticket) => ticket.id)[0]).toBe(mine!.id);
    expect(aSeen.map((s) => s.position)).toEqual([1, 1]);
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

  it('stops beating on its own a lease past the hard cap, so a slot nobody released goes quiet', async () => {
    settings.maxWaitMinutes = 1;
    settings.hardCapMinutes = 1;
    const { gate, time } = setup(4);
    const held = track(gate.waitForSlot({ job: 'pnpm' }));
    await settle();

    await time.step(MINUTE + DEFAULT_LEASE_MS);
    vi.advanceTimersByTime(POLL);
    expect(vi.getTimerCount()).toBe(1);
    const lastBeat = slotTime();

    await time.step(POLL);
    vi.advanceTimersByTime(POLL);
    expect(vi.getTimerCount()).toBe(0);
    expect(slotTime()).toBe(lastBeat);
    // A caller whose job really runs longer can still keep it.
    expect(held.slot!.heartbeat()).toBe(true);
    held.slot!.release();
  });

  it('says once when the slot was taken back, and stops refreshing it', async () => {
    const { gate, lines } = setup(4);
    const held = track(gate.waitForSlot({ job: 'pnpm' }));
    await settle();
    // Another job's marker now sits under the same slot name.
    fs.writeFileSync(
      path.join(dir, 'slot-0.json'),
      JSON.stringify({ id: 'ffffffffffffffff', pid: process.pid, startedAt: 1, acquiredAt: 1 })
    );
    expect(held.slot!.heartbeat()).toBe(false);
    expect(held.slot!.heartbeat()).toBe(false);
    expect(lines).toEqual(['[LoadGate] A pnpm job lost its slot while it ran']);
    held.slot!.release();
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

  it('keeps applying the load limit there, logging no command text', async () => {
    const { gate, time, lines, loadSource } = setup(99);
    const wait = track(gate.gateIfHeavy('pnpm build --filter made-up-secret-name', {}));
    await settle();
    breakFolder();
    await time.step(POLL);
    expect(wait.slot).toBeUndefined();
    loadSource.set(4);
    await time.step(POLL);
    expect(wait.slot).toMatchObject({ outcome: 'gate-error', waitedMs: 2 * POLL });
    expect(lines).toEqual([
      "[LoadGate] The shared load-gate queue could not be used; heavy jobs wait in this server's own line, one at a time (ENOTDIR)",
    ]);
    expect(lines.join('\n')).not.toContain('made-up-secret-name');
  });

  it('runs the job when even the settings cannot be read', async () => {
    const lines: string[] = [];
    const gate = createLoadGate({
      config: () => {
        throw new Error('made-up unreadable settings');
      },
      dir,
      log: (line) => lines.push(line),
    });
    await expect(gate.waitForSlot({ job: 'pnpm' })).resolves.toMatchObject({
      outcome: 'gate-error',
    });
    expect(lines).toEqual([
      "[LoadGate] The shared load-gate queue could not be used; heavy jobs wait in this server's own line, one at a time (Error)",
      '[LoadGate] The load gate could not wait; heavy jobs run without waiting (Error)',
    ]);
  });

  it('still rejects with the AbortError when taking the ticket out fails too', async () => {
    const { gate, lines } = setup(99);
    const controller = new AbortController();
    const wait = track(gate.waitForSlot({ job: 'pnpm' }, { signal: controller.signal }));
    await settle();
    breakFolder();
    controller.abort();
    await settle();
    expect((wait.error as DOMException).name).toBe('AbortError');
    expect(lines).toEqual([]);
  });

  it('never writes command text, even when a caller passes it as the label', async () => {
    const { gate, lines } = setup(4);
    const slot = await gate.waitForSlot({ job: 'pnpm build --filter made-up-secret-name' });
    expect(slot.outcome).toBe('gate-error');
    expect(lines).toEqual([
      "[LoadGate] The shared load-gate queue could not be used; heavy jobs wait in this server's own line, one at a time (TypeError)",
    ]);
    expect(fs.readdirSync(dir).join('\n')).not.toContain('made-up-secret-name');
  });

  it('logs and keeps waiting when a progress handler throws or rejects', async () => {
    const { gate, lines } = setup(99);
    const rejecting = track(
      gate.waitForSlot({ job: 'pnpm' }, { onWait: () => Promise.reject(new Error('x')) })
    );
    const throwing = track(
      gate.waitForSlot(
        { job: 'tsc' },
        {
          onWait: () => {
            throw new Error('x');
          },
        }
      )
    );
    await settle();
    expect(lines).toEqual([
      '[LoadGate] A wait progress handler failed',
      '[LoadGate] A wait progress handler failed',
    ]);
    expect(rejecting.slot).toBeUndefined();
    expect(throwing.slot).toBeUndefined();
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
  it('lets a light command straight through', async () => {
    const { gate, queue } = setup(99);
    await expect(gate.gateIfHeavy('ls -la', {})).resolves.toBeNull();
    expect(queue.list()).toEqual([]);
  });

  it('queues a heavy command under its program name alone', async () => {
    const { gate, queue } = setup(99);
    const wait = track(gate.gateIfHeavy('pnpm exec tsc -p /made/up/project', { chatId: 'c1' }));
    await settle();
    expect(queue.list().map((ticket) => ticket.job)).toEqual(['tsc']);
    expect(gate.waitingJobs().map((job) => job.chatId)).toEqual(['c1']);
    expect(wait.slot).toBeUndefined();
  });

  it('reads the person’s overrides from settings', async () => {
    settings.heavyCommands = { add: [], remove: ['tsc'] };
    const { gate } = setup(99);
    await expect(gate.gateIfHeavy('tsc -p .', {})).resolves.toBeNull();
  });
});
