/**
 * The outbox (spec `turns-survive-restarts` §6, T4): a follow-up is saved in
 * the same write as the run's ending, and the leased worker carries it out
 * through dead boots, two workers, failures and deadlines, settling the run
 * when the last effect is terminal. Real SQLite throughout; "a dead boot" is a
 * worker whose objects are dropped mid-handler, with the clock moved past its
 * lease, and a fresh worker built on the same database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { createRunRecord } from '../index.js';
import { createRunFactsSink } from '../run-facts-sink.js';
import { RunStore, type TurnRun } from '../run-store.js';
import { EffectStore, type NewEffect, type TurnEffect } from '../effects/effect-store.js';
import {
  EFFECT_LEASE_MS,
  EFFECT_MAX_ATTEMPTS,
  EffectWorker,
  type EffectHandler,
  type EffectHandlers,
} from '../effects/worker.js';
import { NOTIFY_PERSON_NOT_AFTER_MS } from '../effects/handlers/notify-person.js';

const CHAT = 'chat-demo-effects';
const BOOT_A = '01BOOTAAAAAAAAAAAAAAAAAAAA';
const BOOT_B = '01BOOTBBBBBBBBBBBBBBBBBBBB';

let db: Db;
let now: number;
const clock = () => now;

/** A run of the chat, `running`, by legal moves only. */
function runningRun(store: RunStore, chatKey = CHAT): TurnRun {
  let run = store.create({ chatKey, status: 'queued', openedBy: 'caller', origin: null });
  run = store.move(run, 'starting', store.lease());
  run = store.move(run, 'started', { runtime: 'test-mode', runtimeTurnRef: 1 });
  return store.move(run, 'running');
}

/** A follow-up effect of the kind T4 has, with a test handler's delivery. */
function followUp(key: string, over: Partial<NewEffect> = {}): NewEffect {
  return {
    kind: 'notify_person',
    key,
    payload: { notice: 'test' },
    delivery: 'repeatable',
    notAfter: now + NOTIFY_PERSON_NOT_AFTER_MS,
    ...over,
  };
}

/** A handler that records each effect it runs and answers `answer`. */
function recorder(seen: string[], answer: EffectHandler['handle'] = () => ({ kind: 'done' })) {
  return {
    handle: (effect: TurnEffect, ctx: Parameters<EffectHandler['handle']>[1]) => {
      seen.push(effect.id);
      return answer(effect, ctx);
    },
  } satisfies EffectHandler;
}

/** A worker over `db` for boot `epoch`, running `handlers`. */
function workerOn(
  database: Db,
  epoch: string,
  handlers: EffectHandlers
): { effects: EffectStore; runs: RunStore; worker: EffectWorker } {
  const effects = new EffectStore(database, { now: clock });
  const runs = new RunStore(database, { epoch, now: clock });
  return {
    effects,
    runs,
    worker: new EffectWorker({ effects, runs, handlers, epoch, now: clock }),
  };
}

beforeEach(() => {
  db = createTestDb();
  now = Date.parse('2026-11-24T12:00:00.000Z');
});

/** A run record whose turns this test holds, as the dispatcher would. */
function recordOn(database: Db) {
  return createRunRecord(database, { epoch: BOOT_A, now: clock, ownerHolds: () => true });
}

describe('a follow-up is saved in the same write as the run’s state change (§6.1, §4.7)', () => {
  it('a claimed turn whose agent acted gets its notice in the write that records its ending', () => {
    const { store, effects, notices } = recordOn(db);
    const run = runningRun(store);
    expect(notices.claim(CHAT, 1)).toBe(true);

    const sink = createRunFactsSink(store, notices);
    sink.dispatcher.turnActed(run.id);
    sink.dispatcher.turnEnded(CHAT, { ending: 'completed' });

    // Still `running`: its status moves at settle, its notice does not wait.
    expect(store.get(run.id)).toMatchObject({ status: 'running', ending: 'completed' });
    expect(effects.listForRun(run.id)).toEqual([
      expect.objectContaining({
        kind: 'notify_person',
        key: `notify:${run.id}:completed`,
        state: 'pending',
        delivery: 'repeatable',
        notAfter: now + NOTIFY_PERSON_NOT_AFTER_MS,
        payload: expect.objectContaining({
          notice: 'turn_finished',
          runId: run.id,
          ending: 'completed',
          at: new Date(now).toISOString(),
        }),
      }),
    ]);
  });

  it('a rollback of the ending drops its notice with it', () => {
    const { store, effects, notices } = recordOn(db);
    const run = runningRun(store);
    notices.claim(CHAT, 1);
    const sink = createRunFactsSink(store, notices);

    expect(() =>
      store.transaction(() => {
        sink.dispatcher.turnActed(run.id);
        sink.dispatcher.turnEnded(CHAT, { ending: 'completed' });
        throw new Error('power cut before the commit');
      })
    ).toThrow('power cut');

    expect(store.get(run.id)?.ending).toBeNull();
    expect(effects.listForRun(run.id)).toEqual([]);
  });

  it('a turn whose agent had not acted is told at settle, in the write that ends it, once', () => {
    const { store, effects, notices } = recordOn(db);
    const run = runningRun(store);
    notices.claim(CHAT, 1);
    const sink = createRunFactsSink(store, notices);

    sink.dispatcher.turnEnded(CHAT, { ending: 'completed' });
    expect(effects.listForRun(run.id)).toEqual([]);

    sink.report({ kind: 'ended', runId: run.id, ending: 'completed' });
    expect(store.get(run.id)?.status).toBe('ended');
    expect(effects.listForRun(run.id).map((effect) => effect.key)).toEqual([
      `notify:${run.id}:completed`,
    ]);
  });

  it('a turn a pause put back owes nothing; a turn told at turn_end is not told again at settle', () => {
    const { store, effects, notices } = recordOn(db);
    const sink = createRunFactsSink(store, notices);
    const held = runningRun(store, 'chat-held');
    notices.claim('chat-held', 1);
    sink.dispatcher.turnEnded('chat-held', { ending: 'completed' });
    sink.dispatcher.pauseCut(held.id);
    expect(store.get(held.id)?.status).toBe('queued');
    expect(effects.listForRun(held.id)).toEqual([]);

    const told = runningRun(store, 'chat-told');
    notices.claim('chat-told', 1);
    sink.dispatcher.turnActed(told.id);
    sink.dispatcher.turnEnded('chat-told', { ending: 'completed' });
    sink.report({ kind: 'ended', runId: told.id, ending: 'completed' });
    expect(effects.listForRun(told.id)).toHaveLength(1);
  });

  it('only the run’s own turn is claimed: another turn, or a chat with no live run, is not', () => {
    const { store, notices } = recordOn(db);
    runningRun(store);
    expect(notices.claim(CHAT, 2)).toBe(false);
    expect(notices.claim('chat-without-a-run', 1)).toBe(false);
  });

  it('a follow-up that cannot be written rolls the state change back', () => {
    const effects = new EffectStore(db, { now: clock });
    const store = new RunStore(db, {
      epoch: BOOT_A,
      now: clock,
      // A follow-up with no deadline: the table's CHECK refuses it (§6.1).
      onEnded: (ended) => void effects.insert(followUp(`k:${ended.id}`, { notAfter: null })),
    });
    const run = runningRun(store);

    expect(() => store.move(run, 'ended', { ending: 'completed' })).toThrow();
    expect(store.get(run.id)?.status).toBe('running');
  });

  it('a second write of one key is the same effect', () => {
    const effects = new EffectStore(db, { now: clock });
    expect(effects.insert(followUp('same'))).toBe(true);
    expect(effects.insert(followUp('same'))).toBe(false);
  });
});

describe('leases (§6.1)', () => {
  it('a lease a dead boot held is taken back once it runs out, and run once', async () => {
    const seen: string[] = [];
    const a = workerOn(db, BOOT_A, { notify_person: recorder(seen, () => new Promise(() => {})) });
    a.effects.insert(followUp('dies-mid-handler'));
    // Boot A takes it and dies inside the handler: its pass never ends.
    void a.worker.runOnce();
    await Promise.resolve();
    expect(seen).toHaveLength(1);

    const b = workerOn(db, BOOT_B, { notify_person: recorder(seen) });
    now += EFFECT_LEASE_MS - 1;
    expect(await b.worker.runOnce()).toBe(0); // A's lease still stands

    now += 2;
    expect(await b.worker.runOnce()).toBe(1);
    expect(b.effects.get(seen[0]!)).toMatchObject({
      state: 'done',
      leaseOwner: BOOT_B,
      attempts: 2,
    });
    expect(seen).toEqual([seen[0], seen[0]]);
  });

  it('a lease this boot holds is never taken back by itself, however late', async () => {
    const seen: string[] = [];
    const a = workerOn(db, BOOT_A, { notify_person: recorder(seen, () => new Promise(() => {})) });
    a.effects.insert(followUp('slow'));
    void a.worker.runOnce();
    await Promise.resolve();

    now += EFFECT_LEASE_MS * 10; // a laptop asleep
    expect(await a.worker.runOnce()).toBe(0);
    expect(a.effects.get(seen[0]!)).toMatchObject({ state: 'leased', leaseOwner: BOOT_A });
  });

  it('a `once` effect a dead boot held ends `unknown` and is never run again', async () => {
    const seen: string[] = [];
    const a = workerOn(db, BOOT_A, { notify_person: recorder(seen, () => new Promise(() => {})) });
    a.effects.insert(followUp('once-only', { delivery: 'once' }));
    void a.worker.runOnce();
    await Promise.resolve();

    const b = workerOn(db, BOOT_B, { notify_person: recorder(seen) });
    now += EFFECT_LEASE_MS + 1;
    expect(await b.worker.runOnce()).toBe(0);
    expect(b.effects.get(seen[0]!)).toMatchObject({
      state: 'unknown',
      outcome: { reason: 'lease_lapsed' },
    });
    expect(seen).toHaveLength(1);
  });

  it('two workers on one database file never run one effect twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dorkos-effects-'));
    try {
      const file = join(dir, 'dork.db');
      const first = createDb(file);
      runMigrations(first);
      const second = createDb(file);
      const seen: string[] = [];
      // Each handler yields, so the two workers' passes interleave.
      const slow = () =>
        recorder(seen, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { kind: 'done' };
        });
      const a = workerOn(first, BOOT_A, { notify_person: slow() });
      const b = workerOn(second, BOOT_B, { notify_person: slow() });
      for (let i = 0; i < 20; i += 1) a.effects.insert(followUp(`shared-${i}`));

      const [byA, byB] = await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);

      expect(byA + byB).toBe(20);
      expect(byA).toBeGreaterThan(0);
      expect(byB).toBeGreaterThan(0);
      expect(new Set(seen).size).toBe(20);
      expect(seen).toHaveLength(20);
      first.$client.close();
      second.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a run’s follow-ups run in the order they were written', async () => {
    const seen: string[] = [];
    const { effects, runs, worker } = workerOn(db, BOOT_A, { notify_person: recorder(seen) });
    const run = runningRun(runs);
    const later = followUp('second', { runId: run.id, availableAt: now });
    effects.insert(followUp('first', { runId: run.id, availableAt: now + 5_000 }));
    effects.insert(later);

    // The first is not due yet, so the second waits behind it.
    expect(await worker.runOnce()).toBe(0);
    now += 5_000;
    expect(await worker.runOnce()).toBe(2);
    expect(seen.map((id) => effects.get(id)!.key)).toEqual(['first', 'second']);
  });
});

describe('retries (§6.1)', () => {
  it('a throw on a repeatable effect retries after 1 s, 5 s, 30 s, 2 min, then every 10 min, and drops after the eighth', async () => {
    const seen: string[] = [];
    const { effects, worker } = workerOn(db, BOOT_A, {
      notify_person: recorder(seen, () => {
        throw new Error('the inbox is not up yet');
      }),
    });
    effects.insert(followUp('flaky', { notAfter: now + 7 * 24 * 3600_000 }));

    const waits: number[] = [];
    for (let attempt = 1; attempt < EFFECT_MAX_ATTEMPTS; attempt += 1) {
      expect(await worker.runOnce()).toBe(1);
      const effect = effects.get(seen[0]!)!;
      expect(effect).toMatchObject({ state: 'pending', attempts: attempt });
      waits.push(effect.availableAt - now);
      now = effect.availableAt - 1;
      expect(await worker.runOnce()).toBe(0); // not before its backoff
      now += 1;
    }
    expect(waits).toEqual([1_000, 5_000, 30_000, 120_000, 600_000, 600_000, 600_000]);

    expect(await worker.runOnce()).toBe(1);
    expect(effects.get(seen[0]!)).toMatchObject({
      state: 'dropped',
      attempts: EFFECT_MAX_ATTEMPTS,
      outcome: expect.objectContaining({ reason: 'attempts_exhausted' }),
    });
    expect(seen).toHaveLength(EFFECT_MAX_ATTEMPTS);
  });

  it('a throw on a once effect is `unknown`, never retried', async () => {
    const seen: string[] = [];
    const { effects, worker } = workerOn(db, BOOT_A, {
      notify_person: recorder(seen, () => {
        throw new Error('sent, maybe');
      }),
    });
    effects.insert(followUp('once', { delivery: 'once' }));

    expect(await worker.runOnce()).toBe(1);
    now += 3_600_000;
    expect(await worker.runOnce()).toBe(0);
    expect(effects.get(seen[0]!)).toMatchObject({ state: 'unknown' });
  });

  it('a handler’s `wait` hands the effect back for later; `drop` ends it', async () => {
    const seen: string[] = [];
    const { effects, worker } = workerOn(db, BOOT_A, {
      notify_person: recorder(seen, (effect, ctx) =>
        effect.attempts === 1
          ? { kind: 'wait', retryAt: ctx.now() + 2_000 }
          : { kind: 'drop', reason: 'nobody_to_tell' }
      ),
    });
    effects.insert(followUp('waits'));

    expect(await worker.runOnce()).toBe(1);
    expect(effects.get(seen[0]!)).toMatchObject({ state: 'pending', availableAt: now + 2_000 });
    now += 2_000;
    expect(await worker.runOnce()).toBe(1);
    expect(effects.get(seen[0]!)).toMatchObject({
      state: 'dropped',
      outcome: { reason: 'nobody_to_tell' },
    });
  });
});

describe('expiry and settle (§4.3 transition 13, §6.1)', () => {
  it('an effect past its `not_after` settles `expired` with its reason, and its run settles', async () => {
    const seen: string[] = [];
    const { effects, runs, worker } = workerOn(db, BOOT_A, {
      notify_person: recorder(seen, () => {
        throw new Error('never gets through');
      }),
    });
    const run = runs.move(runningRun(runs), 'ended', { ending: 'completed' });
    const deadline = now + 10_000;
    effects.insert(followUp('late', { runId: run.id, notAfter: deadline }));

    expect(await worker.runOnce()).toBe(1); // fails, retries in 1 s
    now = deadline + 1;
    expect(await worker.runOnce()).toBe(0);

    const [effect] = effects.listForRun(run.id);
    expect(effect).toMatchObject({
      state: 'expired',
      outcome: {
        reason: 'not_after',
        kind: 'notify_person',
        notAfter: new Date(deadline).toISOString(),
      },
    });
    expect(runs.get(run.id)).toMatchObject({ status: 'settled' });
    expect(runs.get(run.id)?.settledAt).not.toBeNull();
    expect(seen).toHaveLength(1); // expired, never told again
  });

  it('a run settles in the transaction that ends its last open effect', async () => {
    const { effects, runs, worker } = workerOn(db, BOOT_A, { notify_person: recorder([]) });
    const run = runs.move(runningRun(runs), 'ended', { ending: 'completed' });
    effects.insert(followUp('one', { runId: run.id }));
    effects.insert(followUp('two', { runId: run.id }));

    expect(await worker.runOnce()).toBe(2);
    expect(runs.get(run.id)?.status).toBe('settled');
  });

  it('a run with nothing to follow it settles on the next pass; one recovery has not decided stays `ended`', async () => {
    const { runs, worker } = workerOn(db, BOOT_A, {});
    const failed = runs.move(runningRun(runs, 'chat-a'), 'ended', { ending: 'failed' });
    const died = runs.move(runningRun(runs, 'chat-b'), 'ended', { ending: 'process_died' });
    const shutDown = runs.move(runningRun(runs, 'chat-c'), 'ended', { ending: 'shutdown' });

    await worker.runOnce();

    expect(runs.get(failed.id)?.status).toBe('settled');
    expect(runs.get(died.id)?.status).toBe('ended');
    expect(runs.get(shutDown.id)?.status).toBe('ended');
  });

  it('the worker’s wake-ups carry an ending’s follow-up out without a pass being asked for', async () => {
    const record = recordOn(db);
    record.worker.start();
    try {
      const run = runningRun(record.store);
      createRunFactsSink(record.store).report({ kind: 'ended', runId: run.id, ending: 'failed' });
      await expect.poll(() => record.store.get(run.id)?.status).toBe('settled');
    } finally {
      record.worker.stop();
    }
  });
});

describe('wake-ups (§6.1)', () => {
  /** A worker whose passes are counted. */
  function counted() {
    const parts = workerOn(db, BOOT_A, {});
    const passes = vi.spyOn(parts.worker, 'runOnce');
    return { ...parts, passes };
  }

  it('wakes that arrive together, or during a pass, ask for one more pass, never a second loop', async () => {
    const { worker, passes } = counted();
    worker.start();
    worker.wake();
    worker.wake();
    await expect.poll(() => passes.mock.calls.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(passes).toHaveBeenCalledTimes(1);

    // A wake while a pass runs: exactly one more pass after it.
    let release!: () => void;
    passes.mockImplementationOnce(async () => {
      worker.wake();
      worker.wake();
      await new Promise<void>((resolve) => (release = resolve));
      return 0;
    });
    worker.wake();
    await expect.poll(() => passes.mock.calls.length).toBe(2);
    release();
    await expect.poll(() => passes.mock.calls.length).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(passes).toHaveBeenCalledTimes(3);
    worker.stop();
  });

  it('a store that cannot say when work is next due is asked again on the next tick, never thrown out of the loop', async () => {
    const { worker, effects, passes } = counted();
    const due = vi.spyOn(effects, 'nextWorkAt').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    worker.start();
    // An unhandled rejection here would fail the test run (and exit a server).
    await expect.poll(() => due.mock.calls.length).toBe(1);
    await expect.poll(() => passes.mock.calls.length, { timeout: 3_000 }).toBe(2);
    worker.stop();
  });

  it('sleeps until the earliest effect falls due, not a tick a second', async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const { worker, effects, passes } = (() => {
        const parts = workerOn(db, BOOT_A, { notify_person: recorder(seen) });
        return { ...parts, passes: vi.spyOn(parts.worker, 'runOnce') };
      })();
      effects.insert(followUp('later', { availableAt: now + 5_000 }));
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(passes).toHaveBeenCalledTimes(1);

      now += 4_000;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(passes).toHaveBeenCalledTimes(1); // no one-second ticks in between

      now += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(passes).toHaveBeenCalledTimes(2);
      expect(seen).toHaveLength(1);
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('no pass runs after stop, whatever was armed or asked for', async () => {
    const { worker, effects, passes } = counted();
    worker.start();
    worker.stop();
    worker.wake();
    effects.insert(followUp('after-stop'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(passes).not.toHaveBeenCalled();
    expect(worker.isRunning).toBe(false);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.$client.close();
});
