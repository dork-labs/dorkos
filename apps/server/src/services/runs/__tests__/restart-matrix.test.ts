/**
 * Tier A kill matrix (spec `turns-survive-restarts` §8, T15, DOR-5234): what
 * recovery (§7.3) does with each run a restart ended. A boot writes the record
 * through legal moves only and dies with no shutdown path; the next boot
 * recovers before its worker's first pass, over the real dispatcher, launch
 * path, queue and notification pipeline (`restart-harness.ts`). The launch
 * gate, the pump change and F8 are `restart-matrix-gate.test.ts`; the
 * lost-work wake (K13) is `restart-matrix-lost-work.test.ts`; another chat's
 * words and the report its sender gets (K3) are `restart-matrix-senders.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, notifications, turnEffects } from '@dorkos/db';
import { getMessageQueueStore } from '../../session/message-queue-store.js';
import { continuationWords } from '../recovery/continue-after-restart.js';
import { RUNS } from '../../../config/constants.js';
import {
  AGENT,
  boot,
  deadBoot,
  h,
  kill,
  pass,
  runningRun,
  setUpHarness,
  startedRun,
  tearDownHarness,
} from './restart-harness.js';

/** Every inbox row of a kind. */
function rows(kind: 'turn.restarted' | 'turn.completed' | 'extension.work_not_started') {
  return h.db.select().from(notifications).where(eq(notifications.kind, kind)).all();
}

/** The runs that continue a run. */
function continuationsOf(runId: string) {
  return h.record!.store.listForChat(h.sessionId).filter((run) => run.continuesRunId === runId);
}

/** A chat's line, as every device reads it (§4.6). */
function lineOf(chatId: string) {
  return h.record!.view(chatId).find((run) => run.notice !== null)?.notice ?? null;
}

let complained = false;

beforeEach(async () => {
  await setUpHarness();
  complained = false;
});

afterEach(async () => {
  await tearDownHarness({ complained });
});

describe('K1, K2: a run that never reached its turn starts once', () => {
  it('K1: saved but not admitted, it starts once after the restart', async () => {
    const dying = deadBoot();
    const { runId } = dying.port.start({
      sessionId: h.sessionId,
      cwd: AGENT.home,
      content: 'from the app: sort the inbox',
      origin: { kind: 'resume' },
      tier: 'owner',
      sourceRef: 'demo-start:k1',
    });
    kill();
    boot();
    expect(h.record!.store.get(runId)?.status).toBe('queued');
    await pass();
    expect(h.answered).toEqual(['from the app: sort the inbox']);
    expect(h.record!.store.get(runId)).toMatchObject({ status: 'ended', ending: 'completed' });
  });

  it('K2: admitted and launching, it goes back in line and starts once', async () => {
    const dying = deadBoot();
    const { runId } = dying.port.start({
      sessionId: h.sessionId,
      cwd: AGENT.home,
      content: 'from the app: sort the inbox',
      origin: { kind: 'resume' },
      tier: 'owner',
      sourceRef: 'demo-start:k2',
    });
    // Admitted and handed over: its start leased, its launch begun, no turn_start.
    expect(dying.effects.leaseNext(dying.store.epoch, 60_000)).toMatchObject({ runId });
    dying.store.move(dying.store.get(runId)!, 'starting', dying.store.lease());
    kill();
    boot();
    expect(h.record!.store.get(runId)?.status).toBe('queued');
    // Handed back for a new launch, after the chat-busy backoff (§6.2).
    const start = h.record!.effects.openStartOf(runId)!;
    h.now = Math.max(h.now, start.availableAt);
    await pass();
    expect(h.answered).toEqual(['from the app: sort the inbox']);
    expect(h.record!.store.get(runId)).toMatchObject({ status: 'ended', ending: 'completed' });
  });
});

describe('K3: killed after turn_start, before the runtime read the words', () => {
  it('ends process_died with delivery unknown, and a person’s words come back as a draft', async () => {
    const dying = deadBoot();
    const run = startedRun(dying.store, { row: 'please tidy the release notes' });
    kill();
    boot();
    await pass();

    expect(h.record!.store.get(run.id)).toMatchObject({
      status: 'settled',
      ending: 'process_died',
      endingDetail: { delivery: 'unknown', restart: 'quiet' },
    });
    // Never replayed: the runtime read nothing after the restart.
    expect(h.answered).toEqual([]);
    const row = getMessageQueueStore()!.get(run.queueMessageId!);
    expect(row).toMatchObject({ restored: true, inTurn: false });
    expect(getMessageQueueStore()!.list(h.sessionId)).toEqual([]);
    expect(
      getMessageQueueStore()!
        .listShown(h.sessionId)
        .map((r) => r.id)
    ).toEqual([row!.id]);
    // The draft carries its own line; the run shows none and tells no inbox.
    expect(lineOf(h.sessionId)).toBeNull();
    expect(rows('turn.restarted')).toEqual([]);
  });

  it('a mini app’s start tells its owner once and lets its prompt go', async () => {
    const dying = deadBoot();
    const run = startedRun(dying.store, {
      origin: { kind: 'extension-start' },
      sourceRef: 'demo-start:abc',
    });
    kill();
    boot();
    await pass();
    boot();
    await pass();
    expect(rows('extension.work_not_started')).toEqual([
      expect.objectContaining({ dedupeKey: `notify:${run.id}:not_started` }),
    ]);
    expect(rows('extension.work_not_started')[0]!.body).toContain('DorkOS restarted');
    expect(h.forgotten).toEqual(['abc']);
  });
});

describe('K4, K5, K6: killed while running', () => {
  it('K4: continued once, attempt 2, same chain, told the fixed words; the person sees the line', async () => {
    const dying = deadBoot();
    const run = runningRun(dying.store);
    kill();
    boot();
    expect(lineOf(h.sessionId)).toBe('restart_continued');
    await pass();

    expect(h.record!.store.get(run.id)).toMatchObject({
      ending: 'process_died',
      endingDetail: { restart: 'continued' },
    });
    expect(h.record!.store.get(run.id)?.recoveryDecidedAt).not.toBeNull();
    const [continuation, ...more] = continuationsOf(run.id);
    expect(more).toEqual([]);
    expect(continuation).toMatchObject({
      attempt: 2,
      attemptReason: 'restart',
      chainId: run.chainId,
      openedBy: 'recovery',
      origin: { kind: 'interactive' },
      status: 'ended',
      ending: 'completed',
    });
    expect(h.answered).toEqual([continuationWords([])]);
    expect(rows('turn.restarted')).toEqual([
      expect.objectContaining({ dedupeKey: `notify:${run.id}:continued` }),
    ]);
    // The words were DorkOS's own, never a row in anyone's composer.
    expect(getMessageQueueStore()!.listShown(h.sessionId)).toEqual([]);

    // Recovery twice decides nothing twice.
    kill();
    boot();
    await pass();
    expect(continuationsOf(run.id)).toHaveLength(1);
    expect(rows('turn.restarted')).toHaveLength(1);
  });

  it('never carries on a private message whose outcome is unknown (DOR-5218)', async () => {
    const dying = deadBoot();
    const run = runningRun(dying.store);
    dying.store.annotate(run.id, { endingDetail: { ...run.endingDetail, outcomeUnknown: true } });
    kill();
    boot();
    await pass();

    expect(h.record!.store.get(run.id)?.endingDetail).toMatchObject({ restart: 'quiet' });
    expect(continuationsOf(run.id)).toEqual([]);
  });

  const startOfContinuation = (deadId: string) => {
    const [continuation] = continuationsOf(deadId);
    return h.record!.effects.byKey(`start:${continuation!.id}:${continuation!.attempt}`)?.payload;
  };

  it('a continuation carries its caller’s own start, never more trust', async () => {
    const dying = deadBoot();
    const run = runningRun(dying.store, { origin: { kind: 'chat-message' } });
    dying.effects.insert({
      kind: 'start_turn',
      key: `start:${run.id}:${run.attempt}`,
      runId: run.id,
      payload: { tier: 'teammate', carriedMarks: { outsider: true }, unattended: true },
      delivery: 'repeatable',
      notAfter: null,
    });
    kill();
    boot();
    await pass();
    expect(startOfContinuation(run.id)).toMatchObject({
      tier: 'teammate',
      carriedMarks: { outsider: true },
      unattended: true,
    });
  });

  it('a continuation of a chat message that opened a new direct chat does not carry its birth record', async () => {
    const dying = deadBoot();
    const run = runningRun(dying.store, { origin: { kind: 'chat-message' } });
    const newDirectChat = {
      receiptId: 'receipt-1',
      fromSessionId: 'chat-asking',
      fromAgentPath: '/agents/asking',
      allocationCreatedAt: '2026-11-28T10:00:00.000Z',
      targetAgent: { id: '01JD0000000000000000000000', path: '/agents/target' },
    };
    dying.effects.insert({
      kind: 'start_turn',
      key: `start:${run.id}:${run.attempt}`,
      runId: run.id,
      payload: { tier: 'teammate', newDirectChat },
      delivery: 'repeatable',
      notAfter: null,
    });
    kill();
    boot();
    await pass();
    const carried = startOfContinuation(run.id);
    expect(carried).toMatchObject({ tier: 'teammate' });
    expect(carried).not.toHaveProperty('newDirectChat');
  });

  it('a continuation of words the person did not type, whose start was never saved, is marked outsider', async () => {
    const dying = deadBoot();
    const run = runningRun(dying.store, { origin: { kind: 'chat-message' } });
    kill();
    boot();
    await pass();
    expect(startOfContinuation(run.id)).toMatchObject({ carriedMarks: { outsider: true } });
  });

  it('K5: a runtime that cannot continue: nothing continues, and the line says so', async () => {
    h.declares.continuesInterruptedTurn = false;
    const run = runningRun(deadBoot().store);
    kill();
    boot();
    await pass();
    expect(h.record!.store.get(run.id)).toMatchObject({
      status: 'settled',
      ending: 'process_died',
      endingDetail: { restart: 'not_resumable' },
    });
    expect(continuationsOf(run.id)).toEqual([]);
    expect(h.answered).toEqual([]);
    expect(lineOf(h.sessionId)).toBe('restart_stopped');
    expect(rows('turn.restarted')[0]).toMatchObject({
      title: 'A reply stopped when DorkOS restarted',
    });
  });

  it('K6: waiting on the person: nothing continues, and the "waited on you" line', async () => {
    const dying = deadBoot();
    const run = runningRun(dying.store);
    dying.store.annotate(run.id, { waitingOnPerson: true });
    kill();
    boot();
    await pass();
    expect(h.record!.store.get(run.id)?.endingDetail.restart).toBe('waited_on_you');
    expect(continuationsOf(run.id)).toEqual([]);
    expect(lineOf(h.sessionId)).toBe('restart_waited_on_you');
  });

  it('F6, the kill half: a stop asked before the kill continues nothing', async () => {
    const dying = deadBoot();
    const run = runningRun(dying.store);
    dying.store.annotate(run.id, {
      endingDetail: { stopRequests: [{ at: dying.store.stamp(), via: 'stop' }] },
    });
    kill();
    boot();
    await pass();
    expect(h.record!.store.get(run.id)?.endingDetail.restart).toBe('quiet');
    expect(continuationsOf(run.id)).toEqual([]);
    expect(lineOf(h.sessionId)).toBeNull();
  });
});

describe('K7, F9: killed after turn_end, before its follow-ups and its settle', () => {
  it('ends with the ending turn_end reported; the notice is told once; a claimed once-effect is unknown', async () => {
    const dying = deadBoot();
    const run = runningRun(dying.store);
    // The ending is on the run at turn_end, its notice saved in the same write;
    // the status would move at settle, after background work drained.
    expect(dying.notices.claim(h.sessionId, 3)).toBe(true);
    dying.notices.noteActed(run.id);
    dying.store.transaction(() => {
      dying.store.annotate(run.id, { ending: 'completed' });
      dying.notices.atTurnEnd(dying.store.get(run.id)!);
    });
    dying.effects.insert({
      kind: 'deliver_room_handoff',
      key: 'handoff:demo',
      payload: {},
      delivery: 'once',
      notAfter: h.now + 60_000_000,
    });
    // The dying worker had claimed both.
    expect(dying.effects.leaseNext(dying.store.epoch, 60_000)?.kind).toBe('notify_person');
    expect(dying.effects.leaseNext(dying.store.epoch, 60_000)?.kind).toBe('deliver_room_handoff');
    kill();
    boot();
    await pass();
    await pass();

    expect(h.record!.store.get(run.id)).toMatchObject({ status: 'settled', ending: 'completed' });
    expect(continuationsOf(run.id)).toEqual([]);
    expect(rows('turn.completed')).toHaveLength(1);
    const effects = h.record!.effects.listForRun(run.id);
    expect(effects.find((e) => e.kind === 'notify_person')).toMatchObject({ state: 'done' });
    // Taken back as unknown, never run again: still one attempt.
    const handoff = h.db
      .select()
      .from(turnEffects)
      .where(eq(turnEffects.key, 'handoff:demo'))
      .get();
    expect(handoff).toMatchObject({ state: 'unknown', attempts: 1 });
  });
});

describe('K8: killed during recovery, between two runs’ transactions', () => {
  it('leaves every run fully decided or untouched; the next boot decides the rest, once', async () => {
    const dying = deadBoot();
    const first = runningRun(dying.store);
    const other = crypto.randomUUID();
    const second = runningRun(dying.store, { chatKey: other });
    kill();
    h.computerWired = false;
    // Recovery dies on the second run's transaction.
    boot(
      {},
      {
        recovery: {
          settledElsewhere: (run) => {
            if (run.id === second.id) throw new Error('the process died here');
            return false;
          },
        },
      }
    );
    complained = true;
    const store = h.record!.store;
    expect(store.get(first.id)).toMatchObject({
      status: 'ended',
      endingDetail: { restart: 'continued' },
    });
    const firstDecidedAt = store.get(first.id)!.recoveryDecidedAt;
    // Untouched by any decision: at most retired as T2 retires a dead run (§4.7).
    expect(store.get(second.id)?.recoveryDecidedAt).toBeNull();
    expect(store.get(second.id)?.endingDetail.restart).toBeUndefined();
    expect(h.record!.effects.listForRun(second.id)).toEqual([]);

    kill();
    boot();
    expect(h.record!.store.get(second.id)?.endingDetail.restart).toBe('continued');
    expect(h.record!.store.get(first.id)?.recoveryDecidedAt).toBe(firstDecidedAt);
    const continues = h
      .record!.effects.listForRun(first.id)
      .concat(h.record!.effects.listForRun(second.id))
      .filter((effect) => effect.kind === 'continue_after_restart');
    expect(continues.map((effect) => effect.key).sort()).toEqual(
      [`continue:${first.id}`, `continue:${second.id}`].sort()
    );
  });
});

describe('K9: four deaths in one chain, with any time between them', () => {
  it('three continuations, then the cap line; a fresh message starts a new chain', async () => {
    h.computerWired = false;
    let dead = runningRun(deadBoot().store);
    const chainId = dead.chainId;
    for (let death = 1; death <= RUNS.RESTART_CONTINUE_MAX; death += 1) {
      kill();
      boot();
      await pass();
      const [next] = continuationsOf(dead.id);
      expect(next).toMatchObject({ chainId, attempt: death + 1 });
      // Days pass before it runs: no window resets the count.
      h.now += 3 * RUNS.RESTART_AGE_BOUND_MS;
      const dying = deadBoot(`01BOOTDEADK9${String(death).padStart(14, '0')}`);
      let run = dying.store.move(next!, 'starting', dying.store.lease());
      run = dying.store.move(run, 'started', { runtime: h.inner.type, ...dying.store.lease() });
      dead = dying.store.move(run, 'running', { deliveredAt: dying.store.stamp() });
    }
    kill();
    boot();
    await pass();
    expect(h.record!.store.get(dead.id)?.endingDetail.restart).toBe('chain_cap');
    expect(continuationsOf(dead.id)).toEqual([]);
    expect(h.record!.store.continuationsInChain(chainId)).toBe(RUNS.RESTART_CONTINUE_MAX);
    expect(lineOf(h.sessionId)).toBe('restart_chain_cap');

    const fresh = h.record!.store.create({
      chatKey: h.sessionId,
      status: 'queued',
      openedBy: 'caller',
      origin: { kind: 'interactive' },
    });
    expect(fresh.chainId).toBe(fresh.id);
  });
});

describe('K11: a queued run whose start was lost', () => {
  it('is cancelled start_lost, and whoever asked is told once', async () => {
    const lost = deadBoot().store.create({
      chatKey: h.sessionId,
      status: 'queued',
      openedBy: 'caller',
      origin: { kind: 'resume' },
    });
    kill();
    boot();
    await pass();
    expect(h.record!.store.get(lost.id)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'start_lost' },
    });
    kill();
    boot();
    await pass();
    expect(rows('turn.restarted')).toEqual([
      expect.objectContaining({ dedupeKey: `notify:${lost.id}:start_lost` }),
    ]);
  });
});

describe('K14, the age bound (§7.3): a last sign of life two days old', () => {
  it('is ended and stamped with its line; nothing continues, nobody is told, a person’s row is restored', async () => {
    const dying = deadBoot();
    const running = runningRun(dying.store);
    const other = crypto.randomUUID();
    const started = startedRun(dying.store, { row: 'an old draft', chatKey: other });
    kill();
    h.now += 2 * RUNS.RESTART_AGE_BOUND_MS;
    boot();
    await pass();

    expect(h.record!.store.get(running.id)).toMatchObject({
      status: 'settled',
      ending: 'process_died',
      endingDetail: { restart: 'not_resumable' },
    });
    expect(h.record!.store.get(running.id)?.recoveryDecidedAt).not.toBeNull();
    expect(continuationsOf(running.id)).toEqual([]);
    expect(lineOf(h.sessionId)).toBe('restart_stopped');
    expect(rows('turn.restarted')).toEqual([]);
    expect(getMessageQueueStore()!.get(started.queueMessageId!)?.restored).toBe(true);
    expect(h.answered).toEqual([]);
  });

  it('still tells a mini app’s owner once that its old start did not run', async () => {
    const dying = deadBoot();
    const run = startedRun(dying.store, {
      origin: { kind: 'extension-start' },
      sourceRef: 'demo-start:old',
    });
    kill();
    h.now += 2 * RUNS.RESTART_AGE_BOUND_MS;
    boot();
    await pass();
    boot();
    await pass();
    // The one exception to the bound's silence: nothing starts, but the start
    // an app made is never dropped without a word (§7.3, "The age bound").
    expect(rows('extension.work_not_started')).toEqual([
      expect.objectContaining({ dedupeKey: `notify:${run.id}:not_started` }),
    ]);
    expect(rows('turn.restarted')).toEqual([]);
    expect(continuationsOf(run.id)).toEqual([]);
  });
});
