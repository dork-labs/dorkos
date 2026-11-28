/**
 * Recovery after a restart (spec `turns-survive-restarts` §7.3, DOR-5161):
 * what follows every run a restart ended, decided once, each in one
 * transaction, so a boot that dies partway leaves every run either fully
 * decided or untouched, and running it twice decides nothing twice.
 *
 * **When it runs.** Once at boot, from `startup/steps/after-listen.ts`,
 * before the effects worker starts and before any chat's queue resumes
 * ({@link RunRecovery.recoverAtBoot}). Then again from every worker pass and
 * every launch-gate question ({@link RunRecovery.decidePending}), because a
 * run a gone boot left live is dead only once its lease runs out (§7.1),
 * which after a quick crash is after this boot's own pass. Nothing waits on
 * a run nobody decides.
 *
 * **One run, one transaction** (§7.3, step 4): its ending, what follows it,
 * the follow-up effects and the `recovery_decided_at` stamp commit together:
 *
 * - `starting`: back in line (8); the runtime never saw its words.
 * - `started` or `running` whose `turn_end` was seen: ended with that ending,
 *   as its settle would have; nothing continues.
 * - Ended from `started`: the words are never replayed. A person's own row
 *   comes back as a restored draft (`in_turn` to `restored`); another
 *   sender's row is taken away and its sender told through its own path (a
 *   chat's message reads as failed, a mini app hears its run end, a mini
 *   app's start tells its owner and lets its prompt go).
 * - Ended from `running`: {@link decideRestart}'s rule; a continuation, or a
 *   line, and the person's notice for it.
 *
 * **The age bound** (§7.3): a run whose last sign of life is more than
 * `RUNS.RESTART_AGE_BOUND_MS` old gets its true ending, its line and its
 * stamp, and nothing else: nothing continues, nothing wakes, no person or
 * chat is told. A person's own words still come back as a draft, and a mini
 * app still gets its failed answer, since that starts nothing.
 *
 * **Lost background work, unchanged** (§6.2): each record the boot found
 * becomes a `lost_work_wake`, for a runtime that declares
 * `wakesForLostBackgroundWork`, with today's skips; a chat that is also
 * continued folds the wake into the continuation's words instead.
 *
 * @module services/runs/recovery/run-recovery
 */
import type { RuntimeCapabilities, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { personTyped } from '@dorkos/shared/turn-port';
import { logger } from '../../../lib/logger.js';
import type { EffectStore } from '../effects/effect-store.js';
import { restartNotice, type RestartNoticeCase } from '../effects/restart-notices.js';
import { workNotStartedNotice } from '../effects/work-not-started.js';
import {
  isUndecided,
  type LostBackgroundWork,
  type RestartDecision,
  type RunStore,
  type TurnRun,
} from '../run-store.js';
import type { SpaceTurnPort } from '../turn-port.js';
import { continueAfterRestartEffect } from './continue-after-restart.js';
import { decideRestart, pastAgeBound } from './decide-restart.js';
import { lostWorkKey, lostWorkWakeEffect, type LostWorkRecord } from './lost-work.js';
import { RUNS } from '../../../config/constants.js';

/** The two restart capabilities a runtime declares (§7.2). */
export type RestartCapabilities = Pick<
  RuntimeCapabilities,
  'wakesForLostBackgroundWork' | 'continuesInterruptedTurn'
>;

/**
 * What recovery does to a chat on this computer, handed in by the run record
 * from the computer face's door (`session/turn-port`), so recovery holds no
 * import of turn code of its own.
 */
export interface RecoveryChatSeams {
  /** The id a chat's queue rows (and runs) are kept under. */
  keyOf: (chatId: string) => string;
  /** A person's kept row becomes a restored draft. */
  restoreDraft: (chatKey: string, queueMessageId: string) => void;
  /** Another sender's kept row is taken away. */
  dropRow: (chatKey: string, queueMessageId: string) => void;
  /** Another chat hears its message's turn ended without an answer. */
  tellSender: (chatKey: string, queueMessageId: string) => void;
  /** The launch gate no longer holds the chat: its queue may move. */
  wake: (chatKey: string) => void;
  /** Every queue row a turn kept (`in_turn`), across every chat, by id. */
  keptRowIds: () => string[];
}

/** What recovery needs. */
export interface RunRecoveryDeps {
  store: RunStore;
  effects: EffectStore;
  port: SpaceTurnPort;
  chat: RecoveryChatSeams;
  /** The clock, epoch ms. */
  now: () => number;
  /** A runtime's restart capabilities, by its type name; unknown declares neither. */
  capabilitiesOf?: (runtime: string) => RestartCapabilities | undefined;
  /** The runtime a chat runs on, for a lost-work record that does not name one. */
  runtimeOf?: (sessionId: string) => string | undefined;
  /**
   * Whether what follows a run is somebody else's: a task's run or a room's
   * claim (§7.3). Until tasks and rooms are on the turn port, their own
   * recovery owns their turns, so by default a room's or a schedule's run is
   * never continued here.
   */
  settledElsewhere?: (run: TurnRun) => boolean;
  /** The bound a continuation carries, as `continue-after-restart.ts` reads it. */
  ceilingOf?: (sessionId: string) => TurnPermissionCeiling | undefined;
  /** The folder a chat runs in, where its continuation runs. */
  cwdOf?: (sessionId: string) => string | undefined;
  /**
   * Report into each chat that sent a lost message, through the report path
   * (§7.3, step 4; `reportLostChatMessage`): the composition root hands it in,
   * since that path is the space side's.
   */
  reportLost?: (chatKey: string, queueMessageId: string) => void;
}

/** What the boot found beside the record (§7.3, step 2). */
export interface BootFacts {
  /** The background-work records a previous run left. */
  lostWork?: readonly LostWorkRecord[];
  /** Let a record go once its chat is settled. */
  release?: (record: LostWorkRecord) => void;
  /** The ids, of those asked about, of chats a room or a task drives. */
  drivenElsewhere?: (sessionIds: string[]) => ReadonlySet<string>;
}

/** The person's notice each decision owes, if any. */
const NOTICE: Partial<Record<RestartDecision, RestartNoticeCase>> = {
  continued: 'continued',
  not_resumable: 'not_resumable',
  waited_on_you: 'waited_on_you',
  chain_cap: 'chain_cap',
};

const LIVE: ReadonlySet<TurnRun['status']> = new Set(['starting', 'started', 'running']);

/** By default, a room's or a schedule's run is its own domain's to recover. */
const roomOrSchedule = (run: TurnRun): boolean =>
  run.origin?.kind === 'room' || run.origin?.kind === 'schedule';

/** Recovery, as one boot holds it. See the module documentation. */
export class RunRecovery {
  /** Records still to plan: their chat had a run not decided yet. */
  private waiting: LostWorkRecord[] = [];
  /** Each record's release, by its wake's key, for the handler to call. */
  private readonly releases = new Map<string, () => void>();
  /** Chats a room or a task drives, among the records' chats. */
  private elsewhere: ReadonlySet<string> = new Set();

  /**
   * Bind recovery to the record.
   *
   * @param deps - The stores, the space face, the clock and what runtimes declare.
   */
  constructor(private readonly deps: RunRecoveryDeps) {}

  /**
   * The boot pass (§7.3): take back what a dead boot held, decide every run
   * it ended, cancel the starts it lost, and save the lost-work wakes. Before
   * the worker starts and before any chat's queue resumes. Never throws.
   *
   * @param facts - What the boot found beside the record.
   */
  recoverAtBoot(facts: BootFacts = {}): void {
    const { store, effects } = this.deps;
    this.adopt(facts);
    try {
      // Step 3: a dead boot's leases. Repeatable back to pending, once to unknown.
      effects.reclaimLapsed(store.epoch);
    } catch (err) {
      logger.error('[runs] recovery could not take back a dead boot’s effects', errorOf(err));
    }
    this.decidePending();
    try {
      // Step 5: a `queued` run with neither a row nor an open start is
      // `start_lost`, and whoever asked is told once (`start-turns.ts`).
      store.retireDeadRuns();
    } catch (err) {
      logger.error('[runs] recovery could not cancel lost starts', errorOf(err));
    }
  }

  /**
   * Decide every run a restart ended that is not decided yet, of one chat or
   * every chat, then save the lost-work wakes that were waiting on them.
   * Never throws: a run it cannot decide is logged and tried again later.
   *
   * @param chatKey - Only this chat's, as its queue rows are kept, when given.
   */
  decidePending(chatKey?: string): void {
    const { store } = this.deps;
    for (const run of [...store.deadLiveRuns(chatKey), ...store.undecidedRuns(chatKey)]) {
      this.decide(run.id);
    }
    if (this.waiting.length > 0) this.planLostWork();
    this.handBackKeptRows();
  }

  /**
   * A row a turn kept (`in_turn`) whose run ended from `started` without any
   * decision of recovery's: a gone boot's turn whose `turn_end` was seen, then
   * retired before recovery looked (§7.3, step 4, the recorded-ending case).
   * Its settle would have let the words go; it never came, so the row is
   * handed back here as any `started` run's is, each in its own transaction.
   */
  private handBackKeptRows(): void {
    const { store } = this.deps;
    for (const rowId of this.deps.chat.keptRowIds()) {
      const run = store.findByQueueMessage(rowId);
      const over = run?.status === 'ended' || run?.status === 'settled';
      if (!run || !over || isUndecided(run) || run.endingDetail.delivery !== 'unknown') continue;
      try {
        store.transaction(() => this.handBackRow(run, pastAgeBound(run, this.deps.now())));
      } catch (err) {
        logger.error('[runs] recovery could not hand back a kept row', {
          runId: run.id,
          ...errorOf(err),
        });
      }
    }
  }

  /**
   * The launch gate's question (§7.5), for one chat: does it hold a run a
   * restart ended that is not decided, or a continuation not yet made or not
   * yet started? A live run is the launch-begin check's (§4.7), which every
   * launch path reaches after this one. Whatever a gone boot left in the chat
   * is retired and decided first, so the gate never holds a chat for a run
   * that could be decided now.
   *
   * @param chatId - The chat, by any id it answers to.
   * @param runId - The launching run: the chat's own continuation passes.
   */
  holds(chatId: string, runId?: string): boolean {
    const { store, effects } = this.deps;
    const chatKey = this.deps.chat.keyOf(chatId);
    store.liveRunOf(chatKey);
    if (store.undecidedRuns(chatKey).length > 0) this.decidePending(chatKey);
    if (store.undecidedRuns(chatKey).length > 0) return true;
    const continuation = store.waitingContinuationOf(chatKey);
    if (continuation) return continuation.id !== runId;
    return effects.hasOpen('continue_after_restart', chatKey);
  }

  /**
   * Let a lost-work record go, by its wake's key. A no-op for one this boot
   * never read.
   *
   * @param key - The wake's key.
   */
  releaseLostWork(key: string): void {
    this.releases.get(key)?.();
    this.releases.delete(key);
  }

  /** Take in the boot's facts. */
  private adopt(facts: BootFacts): void {
    const records = facts.lostWork ?? [];
    for (const record of records) {
      this.releases.set(lostWorkKey(record), () => facts.release?.(record));
    }
    this.waiting = [...records];
    try {
      const ids = [...new Set(records.flatMap((record) => [record.sessionId, record.key]))];
      this.elsewhere = ids.length > 0 ? (facts.drivenElsewhere?.(ids) ?? new Set()) : new Set();
    } catch (err) {
      // Unknown is treated as a person's chat: a wake a room did not need is
      // cheaper than one a person did need and never got.
      logger.warn('[runs] could not tell room and task chats apart', errorOf(err));
    }
  }

  /** Decide one run, in one transaction. Logs and leaves it for later if it cannot. */
  private decide(runId: string): void {
    try {
      this.deps.store.transaction(() => this.decideInside(runId));
    } catch (err) {
      logger.error('[runs] recovery could not decide a run', { runId, ...errorOf(err) });
    }
  }

  /** {@link decide}'s body, inside its transaction. */
  private decideInside(runId: string): void {
    const { store, effects } = this.deps;
    let run = store.get(runId);
    if (!run) return;
    if (LIVE.has(run.status)) {
      if (!store.deadLiveRuns(run.sessionId).some((dead) => dead.id === runId)) return;
      if (run.status === 'starting') {
        store.move(run, 'queued', { ownerEpoch: null, leaseUntil: null });
        return;
      }
      const sawEnd = run.ending !== null && run.ending !== 'shutdown';
      store.endTurn(run, 'process_died', {}, sawEnd ? null : run.leaseUntil);
      const ended = store.get(runId)!;
      // Its turn ended before the kill (§4.7), as its settle would have; a
      // row it kept is handed back as any `started` run's is.
      if (sawEnd) {
        if (ended.endingDetail.delivery === 'unknown') {
          this.handBackRow(ended, pastAgeBound(ended, this.deps.now()));
        }
        return;
      }
      run = ended;
    }
    if (!isUndecided(run)) return;
    const now = this.deps.now();
    const stale = pastAgeBound(run, now);
    const decision = decideRestart(run, {
      now,
      epoch: store.epoch,
      continues: (runtime) => this.capabilities(runtime)?.continuesInterruptedTurn === true,
      continuationsInChain: (chainId) => store.continuationsInChain(chainId),
      settledElsewhere: this.deps.settledElsewhere ?? roomOrSchedule,
    });
    const fromStarted = run.endingDetail.delivery === 'unknown';
    const lost = fromStarted ? [] : this.lostWith(run);
    store.annotate(run.id, {
      recoveryDecidedAt: store.stamp(),
      endingDetail: { ...run.endingDetail, restart: decision },
      ...(lost.length > 0 ? { lostBackgroundJson: JSON.stringify(lost) } : {}),
    });
    if (fromStarted) this.handBackWords(run, stale, now);
    if (decision === 'continued') effects.insert(continueAfterRestartEffect(run, now));
    const notice = NOTICE[decision];
    if (notice !== undefined && !stale) effects.insert(restartNotice(run, notice, now));
    // A run owing nothing more settles on the worker's next pass.
    effects.announceWork();
    const chatKey = run.sessionId;
    // Decided: the gate no longer holds the chat for it (§7.5).
    queueMicrotask(() => this.deps.chat.wake(chatKey));
  }

  /**
   * The words of a turn that ended before the runtime read them: never
   * replayed (§6.2), handed back to whoever wrote them (§7.3, step 4).
   */
  private handBackWords(run: TurnRun, stale: boolean, now: number): void {
    const { effects, port } = this.deps;
    this.handBackRow(run, stale);
    if (run.origin?.kind === 'extension-start') {
      const app = port.appOf(run);
      if (app) effects.insert(workNotStartedNotice(run, app, now, 'restarted'));
      port.forgetWords(run);
    }
  }

  /**
   * The queue row a `started` run kept, if it still holds it: a person's
   * words come back as a restored draft, however old; another sender's row
   * goes. Another chat gets its report (within the age bound: a report into a
   * chat is a wake); a mini app's message hears its run end through its own
   * watch.
   */
  private handBackRow(run: TurnRun, stale: boolean): void {
    const { chat } = this.deps;
    const rowId = run.queueMessageId;
    if (rowId === null) return;
    // An earlier build's row has no origin: kept as a draft, never lost.
    if (run.origin === null || personTyped(run.origin)) {
      chat.restoreDraft(run.sessionId, rowId);
      return;
    }
    chat.dropRow(run.sessionId, rowId);
    if (run.origin.kind !== 'chat-message' || stale) return;
    chat.tellSender(run.sessionId, rowId);
    this.deps.reportLost?.(run.sessionId, rowId);
  }

  /** The background work that died with a run's chat, from the boot's records. */
  private lostWith(run: TurnRun): LostBackgroundWork[] {
    return this.waiting
      .filter((record) => this.deps.chat.keyOf(record.sessionId) === run.sessionId)
      .map(() => ({ kind: 'background_work', label: 'a background task' }));
  }

  /** A runtime's restart capabilities, or none when unknown. */
  private capabilities(runtime: string | null | undefined): RestartCapabilities | undefined {
    if (!runtime) return undefined;
    try {
      return this.deps.capabilitiesOf?.(runtime);
    } catch {
      return undefined;
    }
  }

  /**
   * Turn each waiting lost-work record into a wake, or let it go (§7.3, step
   * 4, "Lost background work, unchanged"). A record whose chat still has a run
   * to decide waits for it, so a chat that is continued folds the wake into
   * the continuation's words rather than waking twice.
   */
  private planLostWork(): void {
    const { store, effects } = this.deps;
    const now = this.deps.now();
    const still: LostWorkRecord[] = [];
    for (const record of this.waiting) {
      const key = lostWorkKey(record);
      const chatKey = this.deps.chat.keyOf(record.sessionId);
      const runtime = record.runtime ?? this.deps.runtimeOf?.(record.sessionId);
      const letGo =
        now - record.since > RUNS.RESTART_AGE_BOUND_MS ||
        this.elsewhere.has(record.sessionId) ||
        this.elsewhere.has(record.key) ||
        this.capabilities(runtime)?.wakesForLostBackgroundWork !== true;
      if (letGo) {
        this.releaseLostWork(key);
        continue;
      }
      const live = store.liveRunOf(chatKey);
      if ((live && live.ownerEpoch !== store.epoch) || store.undecidedRuns(chatKey).length > 0) {
        still.push(record);
        continue;
      }
      const continued =
        store.waitingContinuationOf(chatKey) !== undefined ||
        effects.hasOpen('continue_after_restart', chatKey);
      // Woken already by a boot that died before it let the record go, or its
      // wake ended for good: the record goes, nobody is woken twice.
      const saved = effects.byKey(key);
      const settled = saved !== undefined && saved.state !== 'pending' && saved.state !== 'leased';
      if (continued || settled || store.findByStartKey(key)) this.releaseLostWork(key);
      else effects.insert(lostWorkWakeEffect(record, now));
    }
    this.waiting = still;
  }
}

/** An error, as a log line's fields. */
function errorOf(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}
