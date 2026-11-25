/**
 * `notify_person` (spec `turns-survive-restarts` §6.2, §6.4, §8 K7 for this
 * kind): a run that ended `completed` tells its person once, through dead
 * boots on either side of the notification's write, and the projector's
 * emitter leaves a run's turn to it so the person is never told twice. Real
 * SQLite and the real notification pipeline throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, notifications, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { NotificationStore } from '../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../notifications/notification-service.js';
import { watchSessionLifecycle } from '../../notifications/emitters/session-lifecycle.js';
import {
  noteChatTurnStarted,
  resetChatStartedTurns,
} from '../../session/chat-messages/chat-started-turns.js';
import { registerBeatTurn, resetBeatTurns } from '../../heartbeats/beat-turns.js';
import { SessionStateProjector } from '../../session/session-state-projector.js';
import { createRunRecord, getRunRecord, installRunRecord, uninstallRunRecord } from '../index.js';
import { createRunFactsSink } from '../run-facts-sink.js';
import type { RunStore, TurnRun } from '../run-store.js';
import { EffectWorker, EFFECT_LEASE_MS, type EffectHandler } from '../effects/worker.js';
import { notifyPersonHandler } from '../effects/handlers/notify-person.js';

const BOOT_A = '01BOOTAAAAAAAAAAAAAAAAAAAA';
const BOOT_B = '01BOOTBBBBBBBBBBBBBBBBBBBB';

let db: Db;
let now: number;
const clock = () => now;

/** A run of `chatKey`, `running`, by legal moves only. */
function runningRun(store: RunStore, chatKey: string, origin: TurnRun['origin'] = null): TurnRun {
  let run = store.create({ chatKey, status: 'queued', openedBy: 'caller', origin });
  run = store.move(run, 'starting', store.lease());
  run = store.move(run, 'started', { runtime: 'test-mode', runtimeTurnRef: 1 });
  return store.move(run, 'running');
}

/** End a run through the facts sink, as the dispatcher's settle does. */
function endRun(store: RunStore, run: TurnRun, ending: 'completed' | 'failed' = 'completed') {
  createRunFactsSink(store).report({ kind: 'ended', runId: run.id, ending });
}

/** Every "finished" row the outbox wrote for a run. */
function rowsFor(runId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.dedupeKey, `notify:${runId}:completed`))
    .all();
}

/** Every `turn.completed` row, whoever wrote it. */
function finishedRows() {
  return db.select().from(notifications).where(eq(notifications.kind, 'turn.completed')).all();
}

/** Boot B: a fresh run record and worker on the same database, as after a restart. */
function bootB() {
  return createRunRecord(db, { epoch: BOOT_B, now: clock });
}

/** Let the fire-and-forget notify chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  db = createTestDb();
  now = Date.now();
  setNotificationService(new NotificationService(new NotificationStore(db)));
});

afterEach(() => {
  uninstallRunRecord();
  setNotificationService(null);
  resetChatStartedTurns();
  resetBeatTurns();
});

describe('a run that finished tells its person once', () => {
  it('writes one "finished" row under the run’s key, marks the effect done and settles the run', async () => {
    const { store, effects, worker } = createRunRecord(db, { epoch: BOOT_A, now: clock });
    const run = runningRun(store, 'chat-finished');
    endRun(store, run);

    expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(0);

    expect(rowsFor(run.id)).toEqual([
      expect.objectContaining({
        kind: 'turn.completed',
        sessionId: 'chat-finished',
        title: 'A chat finished',
      }),
    ]);
    expect(effects.listForRun(run.id)).toEqual([
      expect.objectContaining({
        state: 'done',
        outcome: { notificationId: rowsFor(run.id)[0]!.id },
      }),
    ]);
    expect(store.get(run.id)?.status).toBe('settled');
  });

  it('owes nothing for a turn that did not finish, or whose finishing is not news', () => {
    const { store, effects } = createRunRecord(db, { epoch: BOOT_A, now: clock });
    const failed = runningRun(store, 'chat-failed');
    endRun(store, failed, 'failed');
    const beat = runningRun(store, 'chat-beat-origin', { kind: 'heartbeat' });
    endRun(store, beat);
    const fromChat = runningRun(store, 'chat-from-chat', { kind: 'chat-message' });
    endRun(store, fromChat);
    noteChatTurnStarted('chat-live-chat', now);
    const liveChat = runningRun(store, 'chat-live-chat');
    endRun(store, liveChat);
    registerBeatTurn('chat-live-beat', { agentId: 'agent-1', beatId: 'b1', messageId: 'm1' });
    const liveBeat = runningRun(store, 'chat-live-beat');
    endRun(store, liveBeat);

    for (const run of [failed, beat, fromChat, liveChat, liveBeat]) {
      expect(store.get(run.id)?.status).toBe('ended');
      expect(effects.listForRun(run.id)).toEqual([]);
    }
  });
});

describe('K7 for notify_person: a dead boot around the notification’s write', () => {
  it('a boot that dies inside the write leaves no row, and the next boot tells it once', async () => {
    const a = createRunRecord(db, { epoch: BOOT_A, now: clock });
    const run = runningRun(a.store, 'chat-k7-inside');
    endRun(a.store, run);
    const real = notifyPersonHandler();
    const diesInside: EffectHandler = {
      async handle(effect, ctx) {
        // The power goes after the row's INSERT and before its commit.
        await Promise.resolve(
          real.handle(effect, {
            ...ctx,
            markDone: () => {
              throw new Error('power cut');
            },
          })
        ).catch(() => undefined);
        return new Promise(() => {}); // and the process is gone
      },
    };
    const dying = new EffectWorker({
      effects: a.effects,
      runs: a.store,
      handlers: { notify_person: diesInside },
      epoch: BOOT_A,
      now: clock,
    });
    void dying.runOnce();
    await expect.poll(() => a.effects.listForRun(run.id)[0]?.attempts).toBe(1);
    await flush();
    expect(rowsFor(run.id)).toHaveLength(0);

    const b = bootB();
    now += EFFECT_LEASE_MS + 1;
    expect(await b.worker.runOnce()).toBe(1);

    expect(rowsFor(run.id)).toHaveLength(1);
    expect(b.effects.listForRun(run.id)[0]).toMatchObject({ state: 'done', leaseOwner: BOOT_B });
    expect(b.store.get(run.id)?.status).toBe('settled');
  });

  it('a boot that dies after the write committed leaves nothing for the next boot to redo', async () => {
    const a = createRunRecord(db, { epoch: BOOT_A, now: clock });
    const run = runningRun(a.store, 'chat-k7-after');
    endRun(a.store, run);
    const real = notifyPersonHandler();
    const diesAfter: EffectHandler = {
      async handle(effect, ctx) {
        await real.handle(effect, ctx);
        return new Promise(() => {}); // gone before the worker heard back
      },
    };
    const dying = new EffectWorker({
      effects: a.effects,
      runs: a.store,
      handlers: { notify_person: diesAfter },
      epoch: BOOT_A,
      now: clock,
    });
    void dying.runOnce();
    await expect.poll(() => rowsFor(run.id)).toHaveLength(1);

    const b = bootB();
    now += EFFECT_LEASE_MS + 1;
    expect(await b.worker.runOnce()).toBe(0);
    expect(rowsFor(run.id)).toHaveLength(1);
    expect(b.effects.listForRun(run.id)[0]).toMatchObject({ state: 'done', leaseOwner: BOOT_A });
  });

  it('a kill after `turn_end`, before the settle, ends the run with its ending, never `process_died`, and tells once', async () => {
    const a = createRunRecord(db, { epoch: BOOT_A, now: clock });
    const run = runningRun(a.store, 'chat-k7-drain');
    // `turn_end` was seen and recorded; the kill came while background work drained.
    a.store.annotate(run.id, { ending: 'completed' });

    const b = bootB();
    expect(await b.worker.runOnce()).toBe(0); // A's lease still stands: A may be alive
    expect(b.store.get(run.id)?.status).toBe('running');

    now += EFFECT_LEASE_MS + 1;
    expect(await b.worker.runOnce()).toBe(1);
    expect(b.store.get(run.id)).toMatchObject({ ending: 'completed' });
    expect(await b.worker.runOnce()).toBe(0);
    expect(rowsFor(run.id)).toHaveLength(1);
    expect(b.store.get(run.id)?.status).toBe('settled');
  });
});

describe('the projector’s emitter leaves a run’s turn to the outbox', () => {
  it('a turn the record holds is told once, by its run; a turn with no run, as before', async () => {
    installRunRecord(db, { epoch: BOOT_A });
    const { store, worker } = getRunRecord()!;
    const off = watchSessionLifecycle();
    try {
      const run = runningRun(store, 'sess-with-run');
      const held = new SessionStateProjector('sess-with-run');
      held.ingest({ type: 'turn_start' } as never);
      held.ingest({ type: 'turn_end' } as never);
      await flush();
      expect(finishedRows()).toHaveLength(0); // the run is still live: its settle tells it

      endRun(store, run);
      // The status change may also come just after the settle; still the run's.
      const late = new SessionStateProjector('sess-with-run');
      late.ingest({ type: 'turn_start' } as never);
      late.ingest({ type: 'turn_end' } as never);
      await flush();
      await worker.runOnce();
      expect(finishedRows()).toEqual([
        expect.objectContaining({ dedupeKey: `notify:${run.id}:completed` }),
      ]);

      const loose = new SessionStateProjector('sess-no-run');
      loose.ingest({ type: 'turn_start' } as never);
      loose.ingest({ type: 'turn_end' } as never);
      await flush();
      expect(finishedRows().filter((row) => row.sessionId === 'sess-no-run')).toHaveLength(1);
    } finally {
      off();
    }
  });
});
