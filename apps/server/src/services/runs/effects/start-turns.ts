/**
 * What a run's moves do to its `start_turn` effect (spec `turns-survive-restarts`
 * §6.2, DOR-5157). Every reaction runs inside the transaction of the move that
 * causes it, through the run store's `onMoved`, so the run and its effect
 * never disagree after a crash:
 *
 * - **Started, joined, or cancelled** (transitions 7, 6, 5 and 9): the run's
 *   open `start_turn` is `done` in the same write. A joined or removed run
 *   never leaves its effect leased, and a handler that then finds its run in
 *   a final state writes nothing more.
 * - **Back in line with its words at the space side** (transition 8 for a
 *   run without a queue row): its `start_turn` goes back to `pending`, after
 *   the chat-busy backoff, so it is handed over again for a new launch, and
 *   never twice for one: the computer face answers `already_held` while the
 *   dispatcher still holds the run.
 * - **Cancelled before it started**: a mini app's start tells its owner, and
 *   a start a restart lost tells whoever asked, once (§7.3, step 5); a
 *   continuation that will never start lets its chat's queue move (§7.5).
 * - **A live run lets go** (`starting`, `started` or `running` to anything
 *   else): every waiting `start_turn` is due now. That run may be what a run
 *   waited on as `chat_busy` (its chat) or `machine_full` (a launch slot), so
 *   the wait ends with the run's own end (§3.5), never at the next backoff.
 * - **A new direct chat's first message leaves the line** (DOR-5512): the
 *   chat messages that joined that chat while it waited are due now when it
 *   started, and are cancelled with it (`chat_not_opened`) when it never will,
 *   in the same write, so none is left waiting on a chat that is never born.
 *
 * @module services/runs/effects/start-turns
 */
import type { RunStatus } from '@dorkos/shared/turn-port';
import type { HandedStarts } from '../run-facts-sink.js';
import type { RunStore, TurnRun } from '../run-store.js';
import type { SpaceTurnPort } from '../turn-port.js';
import type { EffectStore, TurnEffect } from './effect-store.js';
import { retryDelayMs } from './worker.js';
import { workNotStartedNotice } from './work-not-started.js';
import { restartNotice } from './restart-notices.js';
import { RUNS } from '../../../config/constants.js';

const LIVE: ReadonlySet<RunStatus> = new Set(['starting', 'started', 'running']);
const NOT_STARTED: ReadonlySet<RunStatus> = new Set(['queued', 'starting']);

/** Why a chat message that joined a new direct chat was cancelled: the chat never opened. */
const CHAT_NOT_OPENED = 'chat_not_opened';

/** How many times a run has waited for a busy chat, as its effect's last outcome counted. */
export function busyRetriesOf(effect: Pick<TurnEffect, 'outcome'> | undefined): number {
  const outcome = effect?.outcome as { busyRetries?: unknown } | null | undefined;
  return typeof outcome?.busyRetries === 'number' ? outcome.busyRetries : 0;
}

/** The record side of the turn port's hand-overs. */
export class StartTurns implements HandedStarts {
  /**
   * Bind the reactions to the stores and the space face.
   *
   * @param runs - The run store.
   * @param effects - The outbox.
   * @param port - The space face, which forgets a run's words and tells its watchers.
   * @param now - The clock, epoch ms.
   * @param wakeChat - Lets a chat's queue move once the launch gate no longer holds it (§7.5).
   */
  constructor(
    private readonly runs: RunStore,
    private readonly effects: EffectStore,
    private readonly port: () => SpaceTurnPort | undefined,
    private readonly now: () => number,
    private readonly wakeChat: (chatKey: string) => void = () => {}
  ) {}

  /**
   * React to one move of a run, inside its transaction.
   *
   * @param run - The run, as stored after the move.
   * @param from - The status it left.
   */
  onRunMoved(run: TurnRun, from: RunStatus): void {
    const to = run.status;
    if (to === 'started' || to === 'superseded' || to === 'cancelled') {
      this.effects.endStartOf(run.id, 'done', { runStatus: to });
    }
    // A mini app's start was answered and will never run: its owner hears
    // once, in the same write, with the app's name and why (§3.1).
    if (to === 'cancelled' && run.origin?.kind === 'extension-start') {
      const app = this.port()?.appOf(run);
      if (app) this.effects.insert(workNotStartedNotice(run, app, this.now()));
    } else if (to === 'cancelled' && run.endingDetail.cancelledBecause === 'start_lost') {
      // Its start was lost with the process that held it: whoever asked
      // hears once (§7.3, step 5), through its source's own record when it
      // keeps one (a task's run), else a notice. Rowless, so never a
      // person's own words. Past the age bound, nobody is told.
      const recent = this.lostRecently(run);
      const heard = this.port()?.endedUnwatched(run, recent) === true;
      if (recent && !heard) this.effects.insert(restartNotice(run, 'start_lost', this.now()));
    }
    // A continuation that will never start no longer holds its chat's
    // launches (§7.5): the chat's queue moves now, after this write commits.
    if (to === 'cancelled' && run.continuesRunId !== null) {
      const chatKey = run.sessionId;
      queueMicrotask(() => this.wakeChat(chatKey));
    }
    // The others first: the run that let go waits out its own backoff.
    if (LIVE.has(from) && !LIVE.has(to)) this.effects.wakeAllStarts();
    if (NOT_STARTED.has(from) && !NOT_STARTED.has(to) && run.origin?.kind === 'chat-message') {
      if (this.opensChat(run.id)) this.opened(run);
    }
    if (from === 'starting' && to === 'queued' && run.queueMessageId === null) this.reopen(run);
    if (
      (from === 'started' || from === 'running') &&
      to === 'queued' &&
      run.queueMessageId === null
    )
      this.startAgain(run);
    this.port()?.moved(run);
  }

  /**
   * Whether a run's start opens a new direct chat: its `start_turn` carries
   * `newDirectChat` (T6b). What admission reads to hold the chat messages that
   * joined that chat behind it (DOR-5512).
   *
   * @param runId - The run.
   */
  opensChat(runId: string): boolean {
    return this.effects
      .listForRun(runId)
      .some(
        (effect) =>
          effect.kind === 'start_turn' &&
          (effect.payload as { newDirectChat?: unknown } | null)?.newDirectChat !== undefined
      );
  }

  /**
   * A new direct chat's first message left the line: the chat messages waiting
   * behind it in that chat are due now, or, when it was cancelled, cancelled
   * too, since nothing can start in a chat that was never born.
   */
  private opened(run: TurnRun): void {
    const joined = this.runs
      .shownRunsOf(run.sessionId)
      .open.filter(
        (other) =>
          other.chatSeq > run.chatSeq &&
          other.origin?.kind === 'chat-message' &&
          other.status === 'queued' &&
          other.queueMessageId === null
      );
    for (const other of joined) {
      if (run.status === 'cancelled') this.cancel(other.id, CHAT_NOT_OPENED);
      else if (this.effects.openStartOf(other.id)?.state === 'pending')
        this.effects.reopenStartOf(other.id, this.now());
    }
  }

  /** Whether a run's last sign of life, its `created_at`, is within the age bound (§7.3). */
  private lostRecently(run: TurnRun): boolean {
    return this.now() - Date.parse(run.createdAt) <= RUNS.RESTART_AGE_BOUND_MS;
  }

  /**
   * A run without a queue row is back with the space side: its `start_turn`
   * goes back to `pending`, after the chat-busy backoff (§6.2).
   *
   * @param run - The run, `queued`.
   */
  reopen(run: TurnRun, delayMs?: number): void {
    const open = this.effects.openStartOf(run.id);
    if (!open) return;
    this.effects.reopenStartOf(
      run.id,
      this.now() + (delayMs ?? retryDelayMs(busyRetriesOf(open) + 1))
    );
  }

  /**
   * A run without a queue row that had started is back in line (a pause cut
   * its turn, transitions 14 and 15): its `start_turn` settled at `started`, so
   * a fresh one is saved beside it, with the same options, or nothing would
   * ever hand it over again.
   *
   * @param run - The run, `queued` again.
   */
  private startAgain(run: TurnRun): void {
    const starts = this.effects.listForRun(run.id).filter((effect) => effect.kind === 'start_turn');
    const last = starts.at(-1);
    if (!last || starts.some((effect) => effect.state === 'pending' || effect.state === 'leased'))
      return;
    this.effects.insert({
      kind: 'start_turn',
      key: `start:${run.id}:${run.attempt}:${starts.length + 1}`,
      runId: run.id,
      ...(last.sessionId !== null ? { sessionId: last.sessionId } : {}),
      payload: last.payload,
      delivery: 'repeatable',
      notAfter: last.notAfter,
    });
  }

  /**
   * A run's words wait in the queue and nothing here holds its launch: the
   * queue starts it, so its `start_turn` ends rather than waits forever.
   *
   * @param runId - The run.
   */
  handOffToQueue(runId: string): void {
    this.effects.endStartOf(runId, 'done', { inQueue: true });
  }

  /**
   * A run's words became a queue row: tell its watchers.
   *
   * @param run - The run, as stored with its row.
   */
  rowTaken(run: TurnRun): void {
    this.port()?.moved(run);
  }

  /**
   * Cancel a run that never started (transition 5 from `queued`, 9 from
   * `starting`), keeping why; its `start_turn` ends in the same write.
   * Nothing is written for a run already past those.
   *
   * @param runId - The run.
   * @param why - What ended it, kept in `ending_detail`.
   * @returns Whether it was cancelled here.
   */
  cancel(runId: string, why: string): boolean {
    return this.runs.transaction(() => {
      const run = this.runs.get(runId);
      if (run?.status !== 'queued' && run?.status !== 'starting') return false;
      this.runs.move(run, 'cancelled', {
        ownerEpoch: null,
        leaseUntil: null,
        waitReason: null,
        endedAt: this.runs.stamp(),
        endingDetail: { ...run.endingDetail, cancelledBecause: why },
      });
      return true;
    });
  }

  /**
   * A run held past its deadline: its `start_turn` is `expired` and the run
   * cancelled as `expired`, in one write (§6.1, "Expiry").
   *
   * @param runId - The run.
   */
  expire(runId: string): void {
    this.runs.transaction(() => {
      this.effects.endStartOf(runId, 'expired', { reason: 'not_after' });
      this.cancel(runId, 'expired');
    });
  }

  /**
   * A waiting run's reason changes (transition 3).
   *
   * @param runId - The run, `queued`.
   * @param reason - Why it waits now.
   */
  waiting(runId: string, reason: NonNullable<TurnRun['waitReason']>): void {
    this.runs.transaction(() => {
      const run = this.runs.get(runId);
      if (run?.status === 'queued' && run.waitReason !== reason) {
        this.runs.move(run, 'queued', { waitReason: reason });
      }
    });
  }
}
