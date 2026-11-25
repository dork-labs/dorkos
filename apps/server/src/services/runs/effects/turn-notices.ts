/**
 * Which runs owe their person a "finished" notice, and the moment each one is
 * written (spec `turns-survive-restarts` §4.7, §6.2; `notify_person`).
 *
 * The projector's emitter decides which turns are news, exactly as it always
 * has, and hands a turn that has a run to {@link TurnNotices.claim}, naming
 * the turn by its `turn_start` seq. The notice is then written in one of two
 * transactions, never both, and never from a timer or a listener after a
 * commit:
 *
 * - at `turn_end`, in the transaction that records the run's ending, when the
 *   agent had acted (no pause can put the turn back after that);
 * - else at settle, in the transaction that moves the run to `ended`, which
 *   comes only once the hold decision let the turn end.
 *
 * A turn a pause put back is forgotten ({@link TurnNotices.forget}). The
 * claim lives in this process's memory: a run whose boot died before either
 * moment is retired by a later boot and told nothing (`notify-person.ts`).
 *
 * @module services/runs/effects/turn-notices
 */
import type { RunStore, TurnRun } from '../run-store.js';
import type { EffectStore } from './effect-store.js';
import { turnFinishedNotice } from './handlers/notify-person.js';

/** The runs this process has been asked to tell their person about. */
export class TurnNotices {
  private readonly owed = new Set<string>();

  /**
   * Build the ledger over the record and the outbox.
   *
   * @param runs - The run record.
   * @param effects - The outbox the notices are written to.
   * @param now - The clock, epoch ms.
   */
  constructor(
    private readonly runs: RunStore,
    private readonly effects: EffectStore,
    private readonly now: () => number
  ) {}

  /**
   * The emitter's turn finished: if it is the chat's `started` or `running`
   * run's turn, the run owes the notice, and the emitter writes nothing.
   *
   * @param chatId - The chat, by any id it answers to.
   * @param turnRef - The turn, by its `turn_start` seq on the chat's stream.
   * @returns Whether the record took the notice over.
   */
  claim(chatId: string, turnRef: number): boolean {
    const live = this.runs.liveRunOf(chatId);
    if (!live || (live.status !== 'started' && live.status !== 'running')) return false;
    if (live.runtimeTurnRef !== turnRef) return false;
    this.owed.add(live.id);
    return true;
  }

  /**
   * At `turn_end`, inside the transaction that recorded the ending: write the
   * notice now when the agent acted.
   *
   * @param run - The run, as stored after its ending was recorded.
   * @param acted - Whether the agent acted before `turn_end`.
   */
  atTurnEnd(run: TurnRun, acted: boolean): void {
    if (acted) this.write(run);
  }

  /**
   * At settle, inside the transaction that ended the run: write the notice it
   * still owes.
   *
   * @param run - The run, as stored after its move to `ended`.
   */
  atSettle(run: TurnRun): void {
    this.write(run);
  }

  /**
   * A pause put the run's turn back: it owes nothing.
   *
   * @param runId - The run.
   */
  forget(runId: string): void {
    this.owed.delete(runId);
  }

  /** Write the notice a run owes, once. */
  private write(run: TurnRun): void {
    if (!this.owed.has(run.id)) return;
    this.effects.insert(turnFinishedNotice(run, run.ending ?? 'completed', this.now()));
    this.owed.delete(run.id);
  }
}
