/**
 * The load gate's shared queue (DOR-4209), over a real temp folder. The only
 * stand-ins are the process probe, where a test needs a pid that was reused,
 * and file times set back by hand, where it needs a heartbeat that stopped.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HolderProbe } from '../holder-identity.js';
import { defaultLoadGateDir, prepareDir } from '../queue-folder.js';
import { DEFAULT_LEASE_MS, TicketQueue } from '../ticket-queue.js';

const OPEN = { slots: 1, load: 2, maxLoad: 16 };
const HOUR = 3_600_000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-load-gate-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A pid nothing runs under any more: a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(child.status).toBe(0);
  return child.pid!;
}

/** Clocks a test moves by hand: a wall clock and a monotonic one. */
function clocks() {
  const state = { wall: Date.UTC(2026, 10, 18, 12), mono: 0 };
  return { state, now: () => state.wall, monoNow: () => state.mono };
}

describe('order', () => {
  it('lines tickets up first come, first served', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'tsc' });
    const c = queue.enqueue({ job: 'docker' });
    expect(queue.list().map((ticket) => ticket.id)).toEqual([a.id, b.id, c.id]);
    expect([queue.position(a), queue.position(b), queue.position(c)]).toEqual([1, 2, 3]);
    expect(a.seq).toBeLessThan(b.seq);
    expect(b.seq).toBeLessThan(c.seq);
  });

  it('puts urgent tickets ahead of normal ones, first come among themselves', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'pnpm', priority: 'urgent' });
    const c = queue.enqueue({ job: 'pnpm' });
    expect(queue.list().map((ticket) => ticket.id)).toEqual([b.id, a.id, c.id]);
    expect(queue.markUrgent(c.id)).toBe(true);
    expect(queue.list().map((ticket) => ticket.id)).toEqual([b.id, c.id, a.id]);
  });

  it('puts a ticket that went missing back at its own place', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'pnpm' });
    fs.rmSync(
      path.join(
        dir,
        fs.readdirSync(dir).find((name) => name.includes(a.id))!
      )
    );
    expect(queue.position(a)).toBe(0);
    expect(queue.tryAcquire(a, OPEN)).toBe('lost');
    queue.rejoin(a);
    expect(queue.list().map((ticket) => ticket.id)).toEqual([a.id, b.id]);
    expect(queue.tryAcquire(a, OPEN)).toBe('slot');
  });
});

describe('slots and load', () => {
  it('runs one job at a time with one slot, and the next once it is released', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'pnpm' });
    expect(queue.tryAcquire(b, OPEN)).toBe('wait');
    expect(queue.tryAcquire(a, OPEN)).toBe('slot');
    expect(queue.runningCount()).toBe(1);
    expect(queue.position(a)).toBe(0);
    expect(queue.tryAcquire(b, OPEN)).toBe('wait');
    queue.release(a);
    expect(queue.runningCount()).toBe(0);
    expect(queue.tryAcquire(b, OPEN)).toBe('slot');
  });

  it('never lets a later ticket take a free slot ahead of an earlier one', () => {
    const queue = new TicketQueue({ dir });
    const [a, b, c] = [1, 2, 3].map(() => queue.enqueue({ job: 'pnpm' }));
    const two = { ...OPEN, slots: 2 };
    expect(queue.tryAcquire(c!, two)).toBe('wait');
    expect(queue.tryAcquire(b!, two)).toBe('slot');
    // One slot left, so only the head of the line may take it.
    expect(queue.tryAcquire(c!, two)).toBe('wait');
    expect(queue.tryAcquire(a!, two)).toBe('slot');
    expect(queue.tryAcquire(c!, two)).toBe('wait');
  });

  it('holds every job while the load is at or over the limit', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    expect(queue.tryAcquire(a, { slots: 1, load: 16, maxLoad: 16 })).toBe('wait');
    expect(queue.tryAcquire(a, { slots: 1, load: 15.9, maxLoad: 16 })).toBe('slot');
  });

  it('lets a let-through job past both the load and the slot count, and counts it as running', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'tsc' });
    const c = queue.enqueue({ job: 'tsc' });
    expect(queue.tryAcquire(a, OPEN)).toBe('slot');
    expect(queue.markLetThrough(c.id)).toBe(true);
    const busy = { slots: 1, load: 99, maxLoad: 16 };
    expect(queue.tryAcquire(c, busy)).toBe('let-through');
    expect(queue.runningCount()).toBe(2);
    // The ticket it passed still waits its turn.
    expect(queue.tryAcquire(b, busy)).toBe('wait');
    queue.release(c);
    queue.release(a);
    expect(queue.runningCount()).toBe(0);
    expect(queue.tryAcquire(b, OPEN)).toBe('slot');
  });

  it('releases safely twice, leaving only number claims behind', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    queue.tryAcquire(a, OPEN);
    queue.release(a);
    queue.release(a);
    expect(queue.runningCount()).toBe(0);
    expect(fs.readdirSync(dir).filter((name) => !name.startsWith('seq-'))).toEqual([]);
  });
});

describe('owners that went away', () => {
  it('removes a ticket and a slot whose owner has exited', () => {
    const pid = deadPid();
    const gone = new TicketQueue({ dir, self: { pid, startedAt: 1 } });
    const held = gone.enqueue({ job: 'pnpm' });
    expect(gone.tryAcquire(held, OPEN)).toBe('slot');
    gone.enqueue({ job: 'tsc' });

    const queue = new TicketQueue({ dir });
    expect(queue.list()).toEqual([]);
    expect(queue.runningCount()).toBe(0);
    const mine = queue.enqueue({ job: 'pnpm' });
    expect(queue.tryAcquire(mine, OPEN)).toBe('slot');
  });

  it('treats a reused pid as gone when its start time does not match', () => {
    const reused = 424_242;
    const probe: HolderProbe = {
      isAlive: (pid) => pid === reused,
      startedAt: (pid) => (pid === reused ? 5_000 : null),
    };
    const old = new TicketQueue({ dir, self: { pid: reused, startedAt: 1_000 } });
    old.enqueue({ job: 'pnpm' });
    expect(new TicketQueue({ dir, probe }).list()).toEqual([]);
  });

  it('keeps a live owner’s ticket, within the start-time tolerance or when the time is unknown', () => {
    const live = 424_243;
    const unknown = 424_244;
    const probe: HolderProbe = {
      isAlive: (pid) => pid === live || pid === unknown,
      startedAt: (pid) => (pid === live ? 5_001 : null),
    };
    new TicketQueue({ dir, self: { pid: live, startedAt: 5_000 } }).enqueue({ job: 'pnpm' });
    new TicketQueue({ dir, self: { pid: unknown, startedAt: 7 } }).enqueue({ job: 'tsc' });
    expect(new TicketQueue({ dir, probe }).list().map((ticket) => ticket.pid)).toEqual([
      live,
      unknown,
    ]);
  });
});

describe('owners that went quiet', () => {
  // The holder and the reader are two queues, as two processes would be; this
  // process is alive throughout, so only the heartbeat can say a slot is forgotten.
  it('frees a slot whose live holder kept one file time for a full lease, timed monotonically', () => {
    const holderClock = clocks();
    const readerClock = clocks();
    const holder = new TicketQueue({ dir, now: holderClock.now });
    const reader = new TicketQueue({ dir, now: readerClock.now, monoNow: readerClock.monoNow });
    const a = holder.enqueue({ job: 'pnpm' });
    expect(holder.tryAcquire(a, OPEN)).toBe('slot');

    // A reader's first sight never counts as quiet.
    expect(reader.runningCount()).toBe(1);
    readerClock.state.mono += DEFAULT_LEASE_MS - 1;
    expect(reader.runningCount()).toBe(1);
    readerClock.state.mono += 1;
    expect(reader.runningCount()).toBe(0);
    // The holder notices it no longer holds the slot, rather than refreshing it.
    expect(holder.beat(a)).toBe(false);
  });

  it('never frees a live, beating holder’s slot when either wall clock jumps an hour', () => {
    const holderClock = clocks();
    const readerClock = clocks();
    const holder = new TicketQueue({ dir, now: holderClock.now });
    const reader = new TicketQueue({ dir, now: readerClock.now, monoNow: readerClock.monoNow });
    const a = holder.enqueue({ job: 'pnpm' });
    holder.tryAcquire(a, OPEN);
    expect(reader.runningCount()).toBe(1);

    // The Mac slept: both wall clocks leap, the monotonic one barely moves.
    readerClock.state.wall += HOUR;
    holderClock.state.wall += HOUR;
    readerClock.state.mono += 1_000;
    expect(reader.runningCount()).toBe(1);

    // The holder keeps beating; each new file time starts the reader's watch again.
    for (let poll = 0; poll < 10; poll += 1) {
      holderClock.state.wall += 5_000;
      expect(holder.beat(a)).toBe(true);
      readerClock.state.mono += DEFAULT_LEASE_MS - 1;
      expect(reader.runningCount()).toBe(1);
    }
  });

  it('never calls its own records quiet, until it disowns them', () => {
    const clock = clocks();
    const queue = new TicketQueue({ dir, now: clock.now, monoNow: clock.monoNow });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'tsc' });
    expect(queue.tryAcquire(a, OPEN)).toBe('slot');
    queue.runningCount();
    clock.state.mono += 10 * DEFAULT_LEASE_MS;
    expect(queue.runningCount()).toBe(1);
    expect(queue.position(b)).toBe(1);

    queue.disown(a);
    queue.runningCount();
    clock.state.mono += DEFAULT_LEASE_MS;
    expect(queue.runningCount()).toBe(0);
  });

  it('drops another queue’s waiting ticket once it goes quiet, and its owner can rejoin', () => {
    const readerClock = clocks();
    const owner = new TicketQueue({ dir });
    const reader = new TicketQueue({ dir, monoNow: readerClock.monoNow });
    const a = owner.enqueue({ job: 'pnpm' });
    expect(reader.list()).toHaveLength(1);
    readerClock.state.mono += DEFAULT_LEASE_MS;
    expect(reader.list()).toEqual([]);
    expect(owner.tryAcquire(a, OPEN)).toBe('lost');
    owner.rejoin(a);
    expect(owner.tryAcquire(a, OPEN)).toBe('slot');
  });

  it('clears an unreadable slot marker once it goes quiet, and not before', () => {
    const clock = clocks();
    const queue = new TicketQueue({ dir, monoNow: clock.monoNow });
    fs.writeFileSync(path.join(dir, 'slot-0.json'), '{not json');
    expect(queue.runningCount()).toBe(0);
    const a = queue.enqueue({ job: 'pnpm' });
    // Not yet quiet, the unreadable marker holds slot 0, so slot 1 is taken instead.
    expect(queue.tryAcquire(a, { ...OPEN, slots: 2 })).toBe('slot');
    expect(fs.existsSync(path.join(dir, 'slot-0.json'))).toBe(true);
    clock.state.mono += DEFAULT_LEASE_MS;
    queue.runningCount();
    expect(fs.existsSync(path.join(dir, 'slot-0.json'))).toBe(false);
  });
});

describe('what a ticket may say', () => {
  it('refuses a job that is not a bare program label', () => {
    const queue = new TicketQueue({ dir });
    expect(() => queue.enqueue({ job: 'pnpm build --filter secret' })).toThrow(TypeError);
    expect(() => queue.enqueue({ job: '../escape' })).toThrow(TypeError);
  });

  it('writes nothing to the shared folder that names an agent, a chat or a command', () => {
    const queue = new TicketQueue({ dir });
    queue.enqueue({ job: 'pnpm' });
    const [file] = fs.readdirSync(dir).filter((name) => name.startsWith('ticket-'));
    const stored = JSON.parse(fs.readFileSync(path.join(dir, file!), 'utf8'));
    expect(Object.keys(stored).sort()).toEqual(
      ['createdAt', 'id', 'job', 'pid', 'priority', 'seq', 'startedAt'].sort()
    );
  });

  it('marks nothing for an id that is not a waiting ticket, and writes no file for it', () => {
    const queue = new TicketQueue({ dir });
    const before = fs.readdirSync(dir);
    expect(queue.markLetThrough('../../etc/passwd')).toBe(false);
    expect(queue.markUrgent('0123456789abcdef')).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(before);
  });
});

describe('the folder', () => {
  it('is a fixed /tmp folder per user, not one that follows TMPDIR', () => {
    const uid = process.getuid?.();
    if (uid === undefined) {
      expect(defaultLoadGateDir()).toBe(path.join(os.tmpdir(), 'dorkos-load-gate'));
      return;
    }
    expect(defaultLoadGateDir()).toBe(`/tmp/dorkos-load-gate-${uid}`);
  });

  it.skipIf(process.getuid === undefined)(
    'tightens loose permissions on a folder this user owns',
    () => {
      fs.chmodSync(dir, 0o777);
      prepareDir(dir);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
  );

  it.skipIf(process.getuid === undefined)('refuses a folder another user owns', () => {
    expect(() => prepareDir(dir, { uid: process.getuid!() + 1 })).toThrow(/another user/);
  });

  // Making a link on Windows needs a privilege a test runner may not have.
  it.skipIf(process.platform === 'win32')('refuses a folder that is a link', () => {
    const target = path.join(dir, 'real');
    const link = path.join(dir, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    expect(() => prepareDir(link)).toThrow(/not a plain folder/);
    expect(() => new TicketQueue({ dir: link })).toThrow(/not a plain folder/);
  });
});
