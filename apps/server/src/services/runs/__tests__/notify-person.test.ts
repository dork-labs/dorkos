/**
 * `notify_person` (spec `turns-survive-restarts` §6.2, §6.4, §8 K7 for this
 * kind): the projector's emitter hands a run's finished turn to the record,
 * by the turn's own `turn_start` seq, and the record tells the person once,
 * through dead boots on either side of the notification's write. A turn with
 * no run, or a boot whose worker never started, is told by the emitter as
 * before. Real SQLite and the real notification pipeline throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, notifications, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { WORK_NOT_STARTED_ENTRIES } from '../effects/work-not-started.js';
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
import { resetAgentPathLookup, setAgentPathLookup } from '../../mesh/agent-path-lookup.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import {
  createRunRecord,
  getRunRecord,
  installRunRecord,
  markRunsShutdown,
  startRunEffects,
  uninstallRunRecord,
  type RunRecord,
} from '../index.js';
import { createRunFactsSink } from '../run-facts-sink.js';
import type { RunStore, TurnRun } from '../run-store.js';
import { EffectWorker, EFFECT_LEASE_MS, type EffectHandler } from '../effects/worker.js';
import { notifyPersonHandler } from '../effects/handlers/notify-person.js';

const BOOT_A = '01BOOTAAAAAAAAAAAAAAAAAAAA';
const BOOT_B = '01BOOTBBBBBBBBBBBBBBBBBBBB';

let db: Db;
let now: number;
const clock = () => now;

/** A run of `chatKey`, `running` with turn `turnRef`, by legal moves only. */
function runningRun(store: RunStore, chatKey: string, turnRef = 1): TurnRun {
  let run = store.create({ chatKey, status: 'queued', openedBy: 'caller', origin: null });
  run = store.move(run, 'starting', store.lease());
  run = store.move(run, 'started', { runtime: 'test-mode', runtimeTurnRef: turnRef });
  return store.move(run, 'running');
}

/** Boot A: this process, holding its turns as the dispatcher would. */
function bootA(): RunRecord {
  return createRunRecord(db, { epoch: BOOT_A, now: clock, ownerHolds: () => true });
}

/** Boot B: a fresh run record and worker on the same database, as after a restart. */
function bootB(): RunRecord {
  return createRunRecord(db, { epoch: BOOT_B, now: clock });
}

/** The emitter handed the turn over, and `turn_end` recorded it: as the dispatcher does. */
function turnEndedAfterActing(record: RunRecord, chatKey: string, acted = true): void {
  expect(record.notices.claim(chatKey, 1)).toBe(true);
  const { dispatcher } = createRunFactsSink(record.store, record.notices);
  if (acted) dispatcher.turnActed(record.store.liveRunOf(chatKey)!.id);
  dispatcher.turnEnded(chatKey, { ending: 'completed' });
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
  resetAgentPathLookup();
  clearTestHomes();
  uninstallRunRecord();
  setNotificationService(null);
  resetChatStartedTurns();
  resetBeatTurns();
});

describe('a run’s finished turn tells its person once', () => {
  it('is in the inbox while the run is still running, and the run settles after its end', async () => {
    const a = bootA();
    const run = runningRun(a.store, 'chat-finished');
    turnEndedAfterActing(a, 'chat-finished');

    expect(await a.worker.runOnce()).toBe(1);
    expect(a.store.get(run.id)?.status).toBe('running'); // background work still drains
    expect(rowsFor(run.id)).toEqual([
      expect.objectContaining({
        kind: 'turn.completed',
        sessionId: 'chat-finished',
        title: 'A chat finished',
      }),
    ]);
    expect(a.effects.listForRun(run.id)).toEqual([
      expect.objectContaining({
        state: 'done',
        outcome: { notificationId: rowsFor(run.id)[0]!.id },
      }),
    ]);

    createRunFactsSink(a.store, a.notices).report({
      kind: 'ended',
      runId: run.id,
      ending: 'completed',
    });
    expect(await a.worker.runOnce()).toBe(0);
    expect(a.store.get(run.id)?.status).toBe('settled');
    expect(rowsFor(run.id)).toHaveLength(1);
  });
});

describe('K7 for notify_person: a dead boot around the notification’s write', () => {
  it('a boot that dies inside the write leaves no row, and the next boot tells it once', async () => {
    const a = bootA();
    const run = runningRun(a.store, 'chat-k7-inside');
    turnEndedAfterActing(a, 'chat-k7-inside');
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
  });

  it('a boot that dies after the write committed leaves nothing for the next boot to redo', async () => {
    const a = bootA();
    const run = runningRun(a.store, 'chat-k7-after');
    turnEndedAfterActing(a, 'chat-k7-after');
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

  it('a kill after `turn_end`, before the settle: the run ends with its ending, never `process_died`, and its notice goes out once', async () => {
    const a = bootA();
    const run = runningRun(a.store, 'chat-k7-drain');
    turnEndedAfterActing(a, 'chat-k7-drain'); // the notice is saved; no worker ran yet

    // The next boot tells it at once: the notice was saved, and no lease holds it.
    const b = bootB();
    expect(await b.worker.runOnce()).toBe(1);
    expect(rowsFor(run.id)).toHaveLength(1);
    // A's run lease still stands (A may be alive), so the run is left running.
    expect(b.store.get(run.id)?.status).toBe('running');

    now += EFFECT_LEASE_MS + 1;
    expect(await b.worker.runOnce()).toBe(0);
    expect(b.store.get(run.id)).toMatchObject({ status: 'settled', ending: 'completed' });
    expect(rowsFor(run.id)).toHaveLength(1);
  });

  it('a run a later boot retires before its notice was written is never told', async () => {
    const a = bootA();
    const run = runningRun(a.store, 'chat-retired');
    // The agent had not acted by `turn_end`: the notice waited for a settle that never came.
    turnEndedAfterActing(a, 'chat-retired', false);

    const b = bootB();
    now += EFFECT_LEASE_MS + 1;
    expect(await b.worker.runOnce()).toBe(0);
    expect(b.store.get(run.id)).toMatchObject({ status: 'settled', ending: 'completed' });
    expect(finishedRows()).toHaveLength(0);
  });
});

describe('the projector’s emitter hands a run’s turn to the record, by the turn', () => {
  /** A projector for `sessionId` whose turn opens now; answers that turn's seq. */
  function openTurn(sessionId: string): { projector: SessionStateProjector; seq: number } {
    const projector = new SessionStateProjector(sessionId);
    const seq = projector.ingest({ type: 'turn_start' } as never).seq;
    return { projector, seq };
  }

  it('a turn the record holds is not told by the emitter; the record tells it; a turn with no run is told as before', async () => {
    installRunRecord(db, { epoch: BOOT_A, ownerHolds: () => true });
    startRunEffects();
    const { store, notices, worker } = getRunRecord()!;
    const off = watchSessionLifecycle();
    try {
      const { projector, seq } = openTurn('sess-with-run');
      const run = runningRun(store, 'sess-with-run', seq);
      projector.ingest({ type: 'turn_end' } as never);
      await flush();
      expect(finishedRows()).toHaveLength(0);

      const { dispatcher } = createRunFactsSink(store, notices);
      dispatcher.turnActed(run.id);
      dispatcher.turnEnded('sess-with-run', { ending: 'completed' });
      await worker.runOnce();
      expect(finishedRows()).toEqual([
        expect.objectContaining({ dedupeKey: `notify:${run.id}:completed` }),
      ]);

      const loose = openTurn('sess-no-run');
      loose.projector.ingest({ type: 'turn_end' } as never);
      await flush();
      expect(finishedRows().filter((row) => row.sessionId === 'sess-no-run')).toHaveLength(1);
    } finally {
      off();
    }
  });

  it('a turn the emitter keeps quiet (another chat’s message, a beat) is never handed over', async () => {
    installRunRecord(db, { epoch: BOOT_A, ownerHolds: () => true });
    startRunEffects();
    const { store, notices, effects } = getRunRecord()!;
    const off = watchSessionLifecycle();
    try {
      noteChatTurnStarted('sess-from-chat', now);
      registerBeatTurn('sess-beat', { agentId: 'agent-1', beatId: 'b1', messageId: 'm1' });
      for (const chat of ['sess-from-chat', 'sess-beat']) {
        const { projector, seq } = openTurn(chat);
        const run = runningRun(store, chat, seq);
        projector.ingest({ type: 'turn_end' } as never);
        await flush();
        const { dispatcher } = createRunFactsSink(store, notices);
        dispatcher.turnActed(run.id);
        dispatcher.turnEnded(chat, { ending: 'completed' });
        expect(effects.listForRun(run.id)).toEqual([]);
      }
      expect(finishedRows()).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('a boot whose worker never started leaves every turn to the emitter', async () => {
    installRunRecord(db, { epoch: BOOT_A, ownerHolds: () => true });
    const { store } = getRunRecord()!;
    const off = watchSessionLifecycle();
    try {
      const { projector, seq } = openTurn('sess-no-worker');
      runningRun(store, 'sess-no-worker', seq);
      projector.ingest({ type: 'turn_end' } as never);
      await flush();
      expect(finishedRows()).toEqual([
        expect.objectContaining({
          sessionId: 'sess-no-worker',
          dedupeKey: expect.stringMatching(/^turn:/),
        }),
      ]);
    } finally {
      off();
    }
  });

  it('a run on a runtime with no folder of its own is named, and its agent stamped, as the emitter would', async () => {
    registerEveryFolderAsHome();
    setAgentPathLookup({
      getByPath: (dir) => (dir === '/Users/dev/acme' ? { id: 'agent-acme' } : undefined),
    });
    // No `placeOf`: like Codex or OpenCode, nothing but the emitter knows the folder.
    installRunRecord(db, { epoch: BOOT_A, ownerHolds: () => true });
    startRunEffects();
    const { store, notices, worker } = getRunRecord()!;
    const off = watchSessionLifecycle();
    try {
      const { projector, seq } = openTurn('sess-codex');
      projector.cwd = '/Users/dev/acme';
      const run = runningRun(store, 'sess-codex', seq); // a dispatcher run: no agent on it
      projector.ingest({ type: 'turn_end' } as never);
      await flush();
      const { dispatcher } = createRunFactsSink(store, notices);
      dispatcher.turnActed(run.id);
      dispatcher.turnEnded('sess-codex', { ending: 'completed' });
      await worker.runOnce();

      const loose = openTurn('sess-loose');
      loose.projector.cwd = '/Users/dev/acme';
      loose.projector.ingest({ type: 'turn_end' } as never);
      await flush();

      const [byRun, byEmitter] = [
        finishedRows().find((row) => row.sessionId === 'sess-codex'),
        finishedRows().find((row) => row.sessionId === 'sess-loose'),
      ];
      expect(byRun).toMatchObject({ title: 'acme finished', agentId: 'agent-acme' });
      expect(byEmitter).toMatchObject({ title: byRun!.title, agentId: byRun!.agentId });
    } finally {
      off();
    }
  });

  it('a window the runtime reopened (DOR-1100) is another turn: its own row, beside the run’s', async () => {
    installRunRecord(db, { epoch: BOOT_A, ownerHolds: () => true });
    startRunEffects();
    const { store, notices, worker } = getRunRecord()!;
    const off = watchSessionLifecycle();
    try {
      const { projector, seq } = openTurn('sess-reopened');
      const run = runningRun(store, 'sess-reopened', seq);
      projector.ingest({ type: 'turn_end' } as never);
      await flush();
      const { dispatcher } = createRunFactsSink(store, notices);
      dispatcher.turnActed(run.id);
      dispatcher.turnEnded('sess-reopened', { ending: 'completed' });
      // A background task finished and woke the agent: a new window, a new
      // turn_start seq, on the same live run (DOR-1100).
      projector.ingest({ type: 'turn_start', origin: 'runtime' } as never);
      projector.ingest({ type: 'turn_end' } as never);
      await flush();
      await worker.runOnce();

      // Two, as today: the emitter tells every window that settles to idle,
      // and the reopened one is work the person did not see finish yet.
      expect(finishedRows().map((row) => row.dedupeKey)).toEqual(
        expect.arrayContaining([`notify:${run.id}:completed`, expect.stringMatching(/^turn:/)])
      );
      expect(finishedRows()).toHaveLength(2);
    } finally {
      off();
    }
  });
});

describe('a graceful shutdown', () => {
  it('saves the "finished" a turn past its turn_end still owes, for the next boot to tell once', async () => {
    installRunRecord(db, { epoch: BOOT_A, now: clock, ownerHolds: () => true });
    const { store, notices } = getRunRecord()!;
    const run = runningRun(store, 'sess-shutdown');
    notices.claim('sess-shutdown', 1);
    // `turn_end` seen before the agent showed anything: the notice waited for settle.
    createRunFactsSink(store, notices).dispatcher.turnEnded('sess-shutdown', {
      ending: 'completed',
    });

    markRunsShutdown();
    expect(store.get(run.id)).toMatchObject({ status: 'ended', ending: 'completed' });
    expect(getRunRecord()!.effects.listForRun(run.id)).toEqual([
      expect.objectContaining({ key: `notify:${run.id}:completed`, state: 'pending' }),
    ]);

    const b = bootB();
    expect(await b.worker.runOnce()).toBe(1);
    expect(rowsFor(run.id)).toHaveLength(1);
  });
});

describe('why a mini app’s start never ran, in the owner’s notice (DOR-5232)', () => {
  const body = (reason: string) =>
    WORK_NOT_STARTED_ENTRIES['extension.work_not_started'].body!({
      runId: '01J0000000000000000000000A',
      sessionId: 'chat',
      extensionId: 'flow',
      name: 'Flow',
      reason,
    });

  it.each([
    ['start_failed', 'It kept failing to start.'],
    ['runtime_mismatch', 'Its agent runs on a different runtime here.'],
    ['start_lost', 'Its first message was lost before it could start.'],
    ['removed', 'Its message was taken off the chat’s queue.'],
    ['session_gone', 'Its chat was gone before it could start.'],
    ['agent_paused', 'Its agent is paused.'],
    ['transient', 'This computer couldn’t start it.'],
  ])('says %s plainly', (reason, words) => {
    expect(body(reason)).toBe(words);
  });
});
