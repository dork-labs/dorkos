/**
 * A person's three actions on a waiting job (DOR-4209): let it through, mark it
 * urgent, move it to the front. Over a real temp folder, with the machine held
 * busy so every job waits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadGateSettings } from '@dorkos/shared/config-schema';
import { createLoadGate } from '../load-gate.js';
import { fixedLoadSource } from '../load-source.js';
import { TicketQueue } from '../ticket-queue.js';

const OPEN = { slots: 1, load: 2, maxLoad: 16 };
const SETTINGS: LoadGateSettings = {
  enabled: true,
  maxLoad: 16,
  slots: 1,
  maxWaitMinutes: 60,
  hardCapMinutes: 240,
  heavyCommands: { add: [], remove: [] },
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-load-gate-actions-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ids = (queue: TicketQueue): string[] => queue.list().map((ticket) => ticket.id);

describe('moving a job to the front', () => {
  it('puts it first, ahead of urgent jobs too', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'pnpm', priority: 'urgent' });
    const c = queue.enqueue({ job: 'tsc' });
    expect(ids(queue)).toEqual([b.id, a.id, c.id]);
    expect(queue.markFront(c.id)).toBe(true);
    expect(ids(queue)).toEqual([c.id, b.id, a.id]);
    expect(queue.list()[0]).toMatchObject({ id: c.id, front: true });
  });

  it('keeps first-come order among jobs moved to the front', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'pnpm' });
    const c = queue.enqueue({ job: 'pnpm' });
    queue.markFront(c.id);
    queue.markFront(b.id);
    expect(ids(queue)).toEqual([b.id, c.id, a.id]);
  });

  it('gives the job at the front the next free slot', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'pnpm' });
    queue.markFront(b.id);
    expect(queue.tryAcquire(a, OPEN)).toBe('wait');
    expect(queue.tryAcquire(b, OPEN)).toBe('slot');
  });

  it('is seen by another process’s queue on the same folder', () => {
    const mine = new TicketQueue({ dir });
    const theirs = new TicketQueue({ dir });
    const a = mine.enqueue({ job: 'pnpm' });
    const b = mine.enqueue({ job: 'pnpm' });
    expect(theirs.markFront(b.id)).toBe(true);
    expect(ids(mine)).toEqual([b.id, a.id]);
  });

  it('leaves no mark behind once the job leaves the line', () => {
    const queue = new TicketQueue({ dir });
    const a = queue.enqueue({ job: 'pnpm' });
    queue.markFront(a.id);
    queue.markUrgent(a.id);
    queue.release(a);
    expect(fs.readdirSync(dir).filter((name) => !name.startsWith('seq-'))).toEqual([]);
  });

  it('refuses an id that is not a waiting ticket’s', () => {
    const queue = new TicketQueue({ dir });
    expect(queue.markFront('../../etc/passwd')).toBe(false);
    expect(queue.markFront('0123456789abcdef')).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('front-'))).toEqual([]);
  });
});

describe('the gate’s actions', () => {
  /** A gate whose jobs all wait, and one waiting job of its own. */
  async function waitingGate() {
    const stop = new AbortController();
    const gate = createLoadGate({
      config: () => SETTINGS,
      dir,
      loadSource: fixedLoadSource(99),
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        }),
      log: () => {},
    });
    const wait = gate.waitForSlot({ job: 'pnpm', agentName: 'Scout' }, { signal: stop.signal });
    wait.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    const queue = new TicketQueue({ dir });
    const other = queue.enqueue({ job: 'tsc' });
    return { gate, stop, other, mine: gate.waitingJobs()[0]! };
  }

  it('lets a job through, marks one urgent and moves one to the front', async () => {
    const { gate, stop, other, mine } = await waitingGate();
    expect(gate.markUrgent(other.id)).toBe('ok');
    expect(gate.waitingJobs().map((job) => job.id)).toEqual([other.id, mine.id]);
    expect(gate.moveToFront(mine.id)).toBe('ok');
    expect(gate.waitingJobs().map((job) => job.id)).toEqual([mine.id, other.id]);
    expect(gate.letThrough(other.id)).toBe('ok');
    expect(gate.waitingJobs()[1]).toMatchObject({ id: other.id, letThrough: true });
    stop.abort();
  });

  it('says which jobs this server queued, keeping its own label', async () => {
    const { gate, stop, other, mine } = await waitingGate();
    expect(mine).toMatchObject({ ownedHere: true, agentName: 'Scout', job: 'pnpm' });
    expect(gate.waitingJobs()[1]).toMatchObject({ id: other.id, ownedHere: false, job: 'tsc' });
    stop.abort();
  });

  it('answers invalid-id for an id that cannot be a ticket’s, and not-found for one not waiting', async () => {
    const { gate, stop } = await waitingGate();
    expect(gate.letThrough('../x')).toBe('invalid-id');
    expect(gate.markUrgent('ABCDEF0123456789')).toBe('invalid-id');
    expect(gate.moveToFront('0123456789abcdef')).toBe('not-found');
    stop.abort();
  });

  it('answers unavailable when the shared folder cannot be used', async () => {
    const { gate, stop, mine } = await waitingGate();
    stop.abort();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a folder');
    expect(gate.letThrough(mine.id)).toBe('unavailable');
  });
});
