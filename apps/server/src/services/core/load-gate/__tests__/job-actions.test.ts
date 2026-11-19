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
import { waitingLineForPerson } from '../person-view.js';
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

  it('puts the most recent move first, even ahead of one moved there before', () => {
    let now = Date.UTC(2026, 10, 19, 12);
    const queue = new TicketQueue({ dir, now: () => now });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'pnpm' });
    const c = queue.enqueue({ job: 'pnpm' });
    queue.markFront(b.id);
    now += 1_000;
    queue.markFront(c.id);
    expect(ids(queue)).toEqual([c.id, b.id, a.id]);
    // Moving an earlier one again puts it back at the very front.
    now += 1_000;
    queue.markFront(b.id);
    expect(ids(queue)).toEqual([b.id, c.id, a.id]);
  });

  it('breaks a tie between two moves at the same instant by number', () => {
    const now = Date.UTC(2026, 10, 19, 12);
    const queue = new TicketQueue({ dir, now: () => now });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'pnpm' });
    queue.markFront(b.id);
    queue.markFront(a.id);
    expect(ids(queue)).toEqual([a.id, b.id]);
  });

  it('shows the latest move at position 1 in the person’s view', () => {
    let now = Date.UTC(2026, 10, 19, 12);
    const queue = new TicketQueue({ dir, now: () => now });
    const a = queue.enqueue({ job: 'pnpm' });
    const b = queue.enqueue({ job: 'tsc' });
    queue.markFront(a.id);
    now += 1_000;
    queue.markFront(b.id);
    const jobs = queue.list().map((ticket) => ({ ...ticket, ownedHere: false }));
    expect(waitingLineForPerson(jobs, now).jobs.map((job) => [job.id, job.position])).toEqual([
      [b.id, 1],
      [a.id, 2],
    ]);
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

describe('a ticket file copied by hand', () => {
  const pad = (seq: number): string => String(seq).padStart(12, '0');
  const FORGED_ID = 'eeeeeeeeeeeeeeee';

  /** A gate with one waiting job of its own, Scout's pnpm, and that job's ticket file. */
  async function gateWithOwnJob() {
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
    gate.waitForSlot({ job: 'pnpm', agentName: 'Scout' }, { signal: stop.signal }).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    const mine = gate.waitingJobs()[0]!;
    const file = fs.readdirSync(dir).find((name) => name.startsWith('ticket-'))!;
    const body = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<
      string,
      unknown
    >;
    const write = (name: string, fields: Record<string, unknown>) =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...body, ...fields }));
    return { gate, stop, mine, write };
  }

  /** The rows a person sees. */
  const rows = (gate: Awaited<ReturnType<typeof gateWithOwnJob>>['gate']) =>
    waitingLineForPerson(gate.waitingJobs()).jobs;

  it('makes no second row from a second file under our id, and keeps our label', async () => {
    const { gate, stop, mine, write } = await gateWithOwnJob();
    write(`ticket-${pad(1)}-${mine.id}.json`, { seq: 1, job: 'docker' });
    const seen = rows(gate);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: mine.id, agentName: 'Scout', label: 'pnpm', position: 1 });
    expect(new TicketQueue({ dir }).list().filter((ticket) => ticket.id === mine.id)).toHaveLength(
      1
    );
    stop.abort();
  });

  it('drops a file whose body names our id under another name', async () => {
    const { gate, stop, mine, write } = await gateWithOwnJob();
    write(`ticket-${pad(mine.seq + 50)}-${FORGED_ID}.json`, {});
    const seen = rows(gate);
    expect(seen.map((row) => row.id)).toEqual([mine.id]);
    expect(seen.filter((row) => row.agentName === 'Scout')).toHaveLength(1);
    stop.abort();
  });

  it('drops a file under our own name whose body names another ticket', async () => {
    const { gate, stop, mine, write } = await gateWithOwnJob();
    write(`ticket-${pad(mine.seq)}-${mine.id}.json`, { id: FORGED_ID, job: 'docker' });
    const seen = rows(gate);
    expect(seen.some((row) => row.id === FORGED_ID || row.label === 'docker')).toBe(false);
    expect(seen.filter((row) => row.agentName === 'Scout').every((row) => row.id === mine.id)).toBe(
      true
    );
    stop.abort();
  });
});
