/**
 * The run record's store (spec `turns-survive-restarts` §8, "Store tests"):
 * every legal and illegal transition, the one-live-run index, the boot
 * epoch's leases, and the rule that nothing but the store touches the table.
 * Real SQLite throughout.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  eq,
  LIVE_TURN_RUN_STATUSES,
  TURN_RUN_ENDINGS,
  TURN_RUN_STATUSES,
  TURN_RUN_WAIT_REASONS,
  turnRuns,
  type Db,
} from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  canTransition,
  RunEndingSchema,
  RunStatusSchema,
  WaitReasonSchema,
  type RunStatus,
} from '@dorkos/shared/turn-port';
import { IllegalRunTransitionError, RUN_LEASE_MS, RunStore, type TurnRun } from '../run-store.js';
import { createRunFactsSink, retireDeadRuns } from '../run-facts-sink.js';

const CHAT = 'chat-demo-1';
const EPOCH = '01BOOTEPOCH000000000000000';

let db: Db;
let now: number;
let store: RunStore;

/** A run put into `status` straight in the table, so any pair can be tried from it. */
function runIn(status: RunStatus, chatKey = CHAT): TurnRun {
  const run = store.create({ chatKey, status: 'queued', openedBy: 'caller', origin: null });
  db.update(turnRuns)
    .set({ status, ...(status === 'queued' ? {} : { ownerEpoch: EPOCH, leaseUntil: now }) })
    .where(eq(turnRuns.id, run.id))
    .run();
  return store.get(run.id)!;
}

/** Hand a run to another boot, its lease ending at `leaseUntil`. */
function ownedElsewhere(run: TurnRun, leaseUntil: number): void {
  db.update(turnRuns)
    .set({ ownerEpoch: '01OTHERBOOT000000000000000', leaseUntil })
    .where(eq(turnRuns.id, run.id))
    .run();
}

beforeEach(() => {
  db = createTestDb();
  now = Date.parse('2026-11-24T12:00:00.000Z');
  store = new RunStore(db, { epoch: EPOCH, now: () => now });
});

describe('the run record’s words', () => {
  it('match the turn port’s, word for word', () => {
    expect([...TURN_RUN_STATUSES]).toEqual(RunStatusSchema.options);
    expect([...TURN_RUN_ENDINGS]).toEqual(RunEndingSchema.options);
    expect([...TURN_RUN_WAIT_REASONS]).toEqual(WaitReasonSchema.options);
  });
});

describe('transitions', () => {
  const statuses = RunStatusSchema.options;

  it.each(statuses.flatMap((from) => statuses.map((to) => [from, to] as const)))(
    '%s → %s is written only when the table holds it',
    (from, to) => {
      const run = runIn(from);
      if (canTransition(from, to)) {
        expect(store.move(run, to).status).toBe(to);
      } else {
        expect(() => store.move(run, to)).toThrow(IllegalRunTransitionError);
        expect(store.get(run.id)?.status).toBe(from);
      }
    }
  );

  it('creates a run only as queued (1) or a runtime’s own running turn (2)', () => {
    expect(
      store.create({ chatKey: CHAT, status: 'queued', openedBy: 'caller', origin: null }).status
    ).toBe('queued');
    const own = store.create({
      chatKey: 'chat-demo-2',
      status: 'running',
      openedBy: 'runtime',
      origin: null,
    });
    expect(own).toMatchObject({
      status: 'running',
      ownerEpoch: EPOCH,
      leaseUntil: now + RUN_LEASE_MS,
    });
  });

  it('refuses a move from a status the run has already left', () => {
    const run = runIn('queued');
    store.move(run, 'starting');
    // `run` still says queued: a second writer holding the old read loses.
    expect(() => store.move(run, 'cancelled')).toThrow(IllegalRunTransitionError);
    expect(store.get(run.id)?.status).toBe('starting');
  });

  it('allocates chat_seq in order within a chat', () => {
    const seqs = [0, 1, 2].map(
      () =>
        store.create({ chatKey: CHAT, status: 'queued', openedBy: 'caller', origin: null }).chatSeq
    );
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe('one live run per chat (§5)', () => {
  it.each(LIVE_TURN_RUN_STATUSES.map((status) => [status]))(
    'a chat with a %s run refuses a second live one',
    (status) => {
      runIn(status);
      const second = store.create({
        chatKey: CHAT,
        status: 'queued',
        openedBy: 'caller',
        origin: null,
      });
      expect(() => store.move(second, 'starting')).toThrow(/UNIQUE/);
      expect(store.get(second.id)?.status).toBe('queued');
    }
  );

  it('another chat is not held by it', () => {
    runIn('running');
    const other = store.create({
      chatKey: 'chat-demo-2',
      status: 'queued',
      openedBy: 'caller',
      origin: null,
    });
    expect(store.move(other, 'starting').status).toBe('starting');
  });

  it('a launch that meets a live run is told so, and writes nothing', () => {
    const sink = createRunFactsSink(store);
    const live = runIn('running');
    const waiting = store.create({
      chatKey: CHAT,
      status: 'queued',
      openedBy: 'caller',
      origin: null,
    });
    expect(sink.dispatcher.launchBegins(waiting.id)).toBe('busy');
    store.move(live, 'ended');
    store.move(store.get(live.id)!, 'settled');
    const launching = runIn('starting', 'chat-demo-3');
    const behind = store.create({
      chatKey: 'chat-demo-3',
      status: 'queued',
      openedBy: 'caller',
      origin: null,
    });
    expect(sink.dispatcher.launchBegins(behind.id)).toBe('queued');
    expect(store.get(behind.id)?.status).toBe('queued');
    expect(store.get(launching.id)?.status).toBe('starting');
    expect(sink.dispatcher.launchBegins(waiting.id)).toBe('starting');
  });
});

describe('the boot epoch', () => {
  it('renews the leases of the live runs this boot owns, and no other', () => {
    const mine = runIn('running');
    const theirs = runIn('running', 'chat-demo-2');
    ownedElsewhere(theirs, now);
    now += 30_000;
    expect(store.renewLeases()).toBe(1);
    expect(store.get(mine.id)?.leaseUntil).toBe(now + RUN_LEASE_MS);
    expect(store.get(theirs.id)?.leaseUntil).toBe(now - 30_000);
  });

  it('retires a live run another boot left once its lease ran out, and never its own', () => {
    const own = runIn('running');
    const started = runIn('started', 'chat-demo-2');
    const starting = runIn('starting', 'chat-demo-3');
    const notYet = runIn('running', 'chat-demo-4');
    ownedElsewhere(started, now - 1);
    ownedElsewhere(starting, now - 1);
    ownedElsewhere(notYet, now + 1_000);
    db.update(turnRuns)
      .set({ leaseUntil: now - 1 })
      .where(eq(turnRuns.id, own.id))
      .run();
    retireDeadRuns(store);
    // A lease this boot let lapse (a laptop asleep) is still its own.
    expect(store.get(notYet.id)?.status).toBe('running');
    expect(store.get(own.id)?.status).toBe('running');
    expect(store.get(started.id)).toMatchObject({
      status: 'ended',
      ending: 'process_died',
      endingDetail: { delivery: 'unknown' },
    });
    expect(store.get(starting.id)?.status).toBe('queued');
  });
});

describe('only the run store touches turn_runs (§4.2)', () => {
  it('no other server source names the table', () => {
    const src = fileURLToPath(new URL('../../../', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const rel = relative(src, full);
          if (rel === 'services/runs/run-store.ts') continue;
          const text = readFileSync(full, 'utf8');
          if (/\bturnRuns\b|['"`]turn_runs['"`]/.test(text)) offenders.push(rel);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
