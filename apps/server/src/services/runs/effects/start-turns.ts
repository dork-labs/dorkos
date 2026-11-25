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
 * - **A live run lets go** (`starting`, `started` or `running` to anything
 *   else): every waiting `start_turn` is due now. That run may be what a run
 *   waited on as `chat_busy` (its chat) or `machine_full` (a launch slot), so
 *   the wait ends with the run's own end (§3.5), never at the next backoff.
 *
 * @module services/runs/effects/start-turns
 */
import type { RunStatus } from '@dorkos/shared/turn-port';
import type { HandedStarts } from '../run-facts-sink.js';
import type { RunStore, TurnRun } from '../run-store.js';
import type { SpaceTurnPort } from '../turn-port.js';
import type { EffectStore, TurnEffect } from './effect-store.js';
import { retryDelayMs } from './worker.js';

const LIVE: ReadonlySet<RunStatus> = new Set(['starting', 'started', 'running']);

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
   */
  constructor(
    private readonly runs: RunStore,
    private readonly effects: EffectStore,
    private readonly port: () => SpaceTurnPort | undefined,
    private readonly now: () => number
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
    // The others first: the run that let go waits out its own backoff.
    if (LIVE.has(from) && !LIVE.has(to)) this.effects.wakeAllStarts();
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
