/**
 * The run record's side of the facts sink (spec `turns-survive-restarts`
 * §4.7, DOR-5159): what each fact and each dispatcher moment writes.
 *
 * The four rules of §4.7 are what this file is for, and every method is
 * written to them:
 *
 * 1. **No write needs a pair outside the fifteen.** Each method reads the run
 *    and moves it only from the status the move is legal from; a fact that
 *    arrives for a run already past it (a settle after a graceful shutdown
 *    ended it) writes nothing. {@link RunStore.move} still throws on an
 *    illegal pair, so a method that asked for one would fail loudly.
 * 2. **One live run per chat.** A launch begins (transition 4) only when the
 *    record shows no other live run of the chat; a runtime's own turn and a
 *    launch reaching `turn_start` put any `starting` run back in line first
 *    (transition 8). The partial unique index is the backstop: a hit is
 *    logged as the bug it is, and the run stays `queued`.
 * 3. **Nothing stays leased forever.** A live run whose owner is another boot
 *    and whose lease ran out is retired before anything reads the chat's live
 *    run (`RunStore.retireDeadRuns`, inside every `liveRunOf`); without it, one crash would hold its
 *    chat's every launch behind a turn nobody is running.
 * 4. **No words lost or doubled.** Queue rows are this file's business only
 *    through the dispatcher's moments: a row's run is cancelled in the
 *    transaction that deletes it, and a run whose launch is under way is left
 *    for that launch to end.
 *
 * @module services/runs/run-facts-sink
 */
import type { RunFact } from '@dorkos/shared/turn-port';
import type {
  DispatcherRunFeed,
  LaunchVerdict,
  ObservedTurnEnd,
  QueueRowExit,
  TurnFactsSink,
} from '../session/turn-port/index.js';
import { logger } from '../../lib/logger.js';
import type { TurnNotices } from './effects/turn-notices.js';
import {
  isUniqueViolation,
  type RunEndingDetail,
  type RunStore,
  type TurnRun,
} from './run-store.js';

/** What the sink needs of the turn port's hand-overs (`effects/start-turns.ts`). */
export interface HandedStarts {
  /**
   * A `queued` run's words went back to the space side without a status
   * change: its `start_turn` goes back to `pending` (§6.2).
   *
   * @param run - The run, `queued`.
   */
  reopen(run: TurnRun): void;
  /**
   * A run's words became a queue row: its watchers hear it, so a caller that
   * kept the words in its own row can let them go (they are the queue's now).
   *
   * @param run - The run, as stored with its row.
   */
  rowTaken(run: TurnRun): void;
}

/**
 * Cancel a run that never started: from `queued` (5) or `starting` (9).
 *
 * @param store - The run store.
 * @param run - The run, `queued` or `starting`.
 * @param why - What ended it.
 * @param detail - What else to keep in `ending_detail`.
 */
function cancelRun(store: RunStore, run: TurnRun, why: string, detail: RunEndingDetail = {}): void {
  store.move(run, 'cancelled', {
    ownerEpoch: null,
    leaseUntil: null,
    waitReason: null,
    endedAt: store.stamp(),
    endingDetail: { ...run.endingDetail, ...detail, cancelledBecause: why },
  });
}

/** Every `starting` run of a chat but one, back to `queued` (transition 8). */
function requeueOtherStarting(store: RunStore, chatKey: string, keepId?: string): void {
  const live = store.liveRunOf(chatKey);
  if (live && live.status === 'starting' && live.id !== keepId) {
    const ours = live.ownerEpoch === store.epoch;
    store.move(live, 'queued', { ownerEpoch: null, leaseUntil: null });
    // A launch of this boot is still under way and holds its words; another
    // boot's would have been retired already, and its words are not here.
    if (ours) store.holdWords(live.id);
  }
}

/** A caller's run reached `turn_start`: 7, or 4 and 7 together for a run still `queued`. */
function recordStarted(store: RunStore, fact: Extract<RunFact, { kind: 'started' }>): void {
  store.transaction(() => {
    let run = store.get(fact.runId);
    if (!run || (run.status !== 'queued' && run.status !== 'starting')) return;
    requeueOtherStarting(store, run.sessionId, run.id);
    if (run.status === 'queued') {
      try {
        run = store.move(run, 'starting', { ...store.lease(), waitReason: null });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The one-live-run index found a second writer the dispatcher's own
        // rules should have kept out (§11). The turn runs anyway; the run
        // stays `queued` so the record never shows two live runs.
        logger.error('[runs] a turn started while another run of its chat was live', {
          runId: run.id,
          sessionId: run.sessionId,
        });
        return;
      }
    }
    store.move(run, 'started', {
      runtime: fact.runtime,
      runtimeTurnRef: fact.runtimeTurnRef,
      turnBindingId: fact.turnBindingId ?? null,
      startedAt: store.stamp(),
      ...store.lease(),
      ...(fact.agentId !== undefined ? { agentId: fact.agentId } : {}),
    });
  });
}

/**
 * A turn the runtime opened by itself reached its own `turn_start`
 * (transition 2, §4.7). It is inserted unless the chat already has a
 * `started` or `running` run, in which case its activity is that run's; a
 * `starting` run goes back in line first.
 */
function recordRuntimeTurn(store: RunStore, fact: Extract<RunFact, { kind: 'started' }>): void {
  store.transaction(() => {
    const existing = store.get(fact.runId);
    if (existing) {
      if (existing.sessionId !== fact.sessionId) {
        logger.error('[runs] a runtime turn reused another chat’s run id', { runId: fact.runId });
      }
      return;
    }
    const live = store.liveRunOf(fact.sessionId);
    if (live && live.status !== 'starting') return;
    requeueOtherStarting(store, fact.sessionId);
    store.create({
      id: fact.runId,
      chatKey: fact.sessionId,
      status: 'running',
      openedBy: 'runtime',
      origin: null,
      runtime: fact.runtime,
      runtimeTurnRef: fact.runtimeTurnRef,
      ...(fact.agentId !== undefined ? { agentId: fact.agentId } : {}),
    });
  });
}

/**
 * The turn ended: 11 or 12, with the ending recorded at `turn_end` if there
 * is one, and the person's "finished" notice it still owes in the same write.
 */
function recordEnded(
  store: RunStore,
  fact: Extract<RunFact, { kind: 'ended' }>,
  notices: TurnNotices | undefined
): void {
  store.transaction(() => {
    const run = store.get(fact.runId);
    if (!run || (run.status !== 'started' && run.status !== 'running')) return;
    // The runtime's refusal is observed at settle, after any `turn_end`, and
    // it is the truer reading of how the turn ended (DOR-2994).
    const refused = fact.ending === 'refused';
    store.endTurn(refused ? { ...run, ending: null } : run, fact.ending, {
      ...(fact.refusal !== undefined ? { refusal: fact.refusal } : {}),
    });
    notices?.atSettle(store.get(run.id)!);
  });
}

/**
 * Apply one of the port's facts.
 *
 * @param store - The run store.
 * @param fact - What happened.
 * @param notices - The runs that owe a "finished" notice, when the outbox is wired.
 */
function report(store: RunStore, fact: RunFact, notices: TurnNotices | undefined): void {
  switch (fact.kind) {
    case 'started':
      if (fact.openedBy === 'runtime') recordRuntimeTurn(store, fact);
      else recordStarted(store, fact);
      return;
    case 'delivered':
      store.transaction(() => {
        const run = store.get(fact.runId);
        if (run?.status === 'started') store.move(run, 'running', { deliveredAt: store.stamp() });
      });
      return;
    case 'waiting_on_person':
    case 'resumed_from_person':
      store.annotate(fact.runId, { waitingOnPerson: fact.kind === 'waiting_on_person' });
      return;
    case 'ended':
      recordEnded(store, fact, notices);
      return;
    case 'accepted':
      if (fact.joinedRunId === undefined) return;
      store.transaction(() => {
        const joined = store.get(fact.joinedRunId!);
        if (joined?.status === 'queued')
          store.move(joined, 'superseded', { endedAt: store.stamp() });
      });
      return;
    case 'background_work':
      // Kept by recovery (T15), which reads what died with a run; nothing
      // reports it before then.
      return;
  }
}

/** What a `turn_end` observed, as the ending the run keeps. */
function observedEnding(run: TurnRun, observed: ObservedTurnEnd): NonNullable<TurnRun['ending']> {
  if (
    observed.limitSince !== undefined &&
    run.startedAt !== null &&
    Date.parse(observed.limitSince) >= Date.parse(run.startedAt)
  ) {
    return 'limited';
  }
  return observed.ending;
}

/**
 * The Mac dispatcher's moments, each written to the record (§4.7).
 *
 * @param store - The run store.
 * @param notices - The runs that owe a "finished" notice, when the outbox is wired.
 */
function dispatcherFeed(
  store: RunStore,
  notices: TurnNotices | undefined,
  starts: HandedStarts | undefined
): DispatcherRunFeed {
  return {
    accept: ({ chatKey, origin, queueMessageId }) =>
      store.create({
        chatKey,
        status: 'queued',
        openedBy: 'caller',
        origin,
        ...(queueMessageId !== undefined ? { queueMessageId } : {}),
      }).id,

    queueRowTaken: (runId, queueMessageId) =>
      store.transaction(() => {
        if (store.get(runId)?.status !== 'queued') return;
        store.annotate(runId, { queueMessageId });
        starts?.rowTaken(store.get(runId)!);
      }),

    handBack: (runId) =>
      store.transaction(() => {
        const run = store.get(runId);
        // From `starting`, the move itself sends its `start_turn` back (§6.2).
        if (run?.status === 'starting') {
          store.move(run, 'queued', { ownerEpoch: null, leaseUntil: null });
        } else if (run?.status === 'queued') {
          starts?.reopen(run);
        }
      }),

    liveRunOf: (chatKey) => store.liveRunOf(chatKey)?.id,

    runOfQueueRow: ({ chatKey, queueMessageId }) =>
      store.transaction(() => {
        // Read the chat's live run first, so a dead boot's `starting` run of
        // this row is back in line before it is looked up.
        store.liveRunOf(chatKey);
        const run = store.findByQueueMessage(queueMessageId);
        if (run?.status === 'queued') {
          // A re-arm is what lifts a pause's hold (transition 3).
          if (run.waitReason === 'paused') store.move(run, 'queued', { waitReason: null });
          return run.id;
        }
        if (run && run.status === 'starting') return run.id;
        // A row an earlier build accepted has no run; nobody recorded its caller.
        return store.create({
          chatKey,
          status: 'queued',
          openedBy: 'caller',
          origin: null,
          queueMessageId,
        }).id;
      }),

    waiting: (runId, reason) =>
      store.transaction(() => {
        const run = store.get(runId);
        if (run?.status === 'queued' && run.waitReason !== reason) {
          store.move(run, 'queued', { waitReason: reason });
        }
      }),

    launchBegins: (runId): LaunchVerdict =>
      store.transaction((): LaunchVerdict => {
        const run = store.get(runId);
        if (!run) return { kind: 'starting' };
        // A deadline or a door refusal ended it while its launch was on the way.
        if (run.status === 'cancelled' || run.status === 'superseded') return { kind: 'gone' };
        if (run.status !== 'queued') return { kind: 'starting' };
        const live = store.liveRunOf(run.sessionId);
        if (live && live.id !== run.id) {
          if (live.status === 'starting') return { kind: 'queued' };
          // Another boot's run is retired only once its lease runs out, and
          // nothing in this process will settle it: say when to look again.
          return live.ownerEpoch !== store.epoch && live.leaseUntil !== null
            ? { kind: 'busy', retryAt: live.leaseUntil + 1 }
            : { kind: 'busy' };
        }
        try {
          store.move(run, 'starting', { ...store.lease(), waitReason: null });
          return { kind: 'starting' };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          logger.error('[runs] the one-live-run index refused a launch', {
            runId,
            sessionId: run.sessionId,
          });
          return { kind: 'queued' };
        }
      }),

    backInLine: (runId) =>
      store.transaction(() => {
        const run = store.get(runId);
        if (run?.status !== 'starting') return;
        store.move(run, 'queued', { ownerEpoch: null, leaseUntil: null });
        // Its words are back in this process's pending set.
        store.holdWords(run.id);
      }),

    cancel: (runId, why) =>
      store.transaction(() => {
        const run = store.get(runId);
        if (run?.status === 'queued' || run?.status === 'starting') cancelRun(store, run, why);
      }),

    supersedeRow: (queueMessageId) =>
      store.transaction(() => {
        const run = store.findByQueueMessage(queueMessageId);
        if (run?.status === 'queued') {
          store.move(run, 'superseded', { waitReason: null, endedAt: store.stamp() });
        } else if (run && run.status !== 'superseded') {
          // A join stops at any row in `launching` (§4.7), so this is a bug.
          logger.error('[runs] a row was folded whose run was not waiting', {
            runId: run.id,
            status: run.status,
          });
        }
      }),

    queueRowsLeaving: (queueMessageIds, why) =>
      store.transaction(() => {
        for (const id of queueMessageIds) rowLeaving(store, id, why);
      }),

    queueRowMoved: (queueMessageId, toChatKey) =>
      store.transaction(() => {
        const run = store.findByQueueMessage(queueMessageId);
        if (run?.status === 'queued') store.moveToChat(run, toChatKey);
        else if (run && run.status !== 'cancelled' && run.status !== 'superseded') {
          // Only a waiting row moves between chats; a live run stays where its turn is.
          logger.error('[runs] a queue row moved whose run was not waiting', {
            runId: run.id,
            status: run.status,
          });
        }
      }),

    turnEnded: (chatKey, observed) =>
      store.transaction(() => {
        const live = store.liveRunOf(chatKey);
        // A stop a receipt already confirmed stays `stopped` (§4.4).
        if (!live || (live.status !== 'started' && live.status !== 'running')) return;
        if (live.ending !== 'stopped') {
          store.annotate(live.id, { ending: observedEnding(live, observed) });
        }
        // The agent acted, so no pause can put the turn back: told now (§4.7).
        notices?.atTurnEnd(store.get(live.id)!);
      }),

    turnActed: (runId) => notices?.noteActed(runId),

    pauseCut: (runId) =>
      store.transaction(() => {
        notices?.forget(runId);
        const run = store.get(runId);
        if (run?.status !== 'started' && run?.status !== 'running') return;
        const { stopRequests, ...rest } = run.endingDetail;
        const theirs = stopRequests?.filter((request) => request.via !== 'pause');
        store.move(run, 'queued', {
          waitReason: 'paused',
          startedAt: null,
          deliveredAt: null,
          runtimeTurnRef: null,
          turnBindingId: null,
          ownerEpoch: null,
          leaseUntil: null,
          waitingOnPerson: false,
          ending: null,
          endingDetail: {
            ...rest,
            ...(theirs && theirs.length > 0 ? { stopRequests: theirs } : {}),
          },
        });
      }),

    rekeyChat: (fromChatKey, toChatKey) => store.rekeyChat(fromChatKey, toChatKey),
  };
}

/** One queue row leaving the table: what becomes of the run that waits on it. */
function rowLeaving(store: RunStore, queueMessageId: string, why: QueueRowExit): void {
  const run = store.findByQueueMessage(queueMessageId);
  if (!run) return;
  if (run.status === 'queued') {
    cancelRun(store, run, why, why === 'outcome_unknown' ? { outcomeUnknown: true } : {});
  } else if (run.status === 'starting' && (why === 'cancelled' || why === 'outcome_unknown')) {
    cancelRun(store, run, why, why === 'outcome_unknown' ? { outcomeUnknown: true } : {});
  } else if (run.status === 'started' && why === 'outcome_unknown') {
    // An earlier boot's private message reached `turn_start` and nobody saw
    // more (§4.7): it ended with its process, and is never replayed.
    store.endTurn(run, 'process_died', { outcomeUnknown: true });
  }
  // `removed` or `session_gone` while a launch is under way: that launch ends
  // the run, as 7 or 9 (§4.7). A `started` or `running` run's row leaves by
  // `delivered` or at settle, which wrote the run first.
}

/**
 * The run record as the turn code's facts sink.
 *
 * @param store - The run store the facts are written to.
 * @param notices - The runs that owe their person a "finished" notice, when the outbox is wired.
 * @param starts - The turn port's hand-overs, when the outbox is wired.
 */
export function createRunFactsSink(
  store: RunStore,
  notices?: TurnNotices,
  starts?: HandedStarts
): TurnFactsSink {
  return {
    report: (fact) => report(store, fact, notices),
    dispatcher: dispatcherFeed(store, notices, starts),
  };
}
