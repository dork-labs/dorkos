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
import { turnFinishedNotice, type ChatPlace } from './handlers/notify-person.js';

/** The runs this process has been asked to tell their person about. */
export class TurnNotices {
  /** Owed runs, with the place the emitter named, by run id. */
  private readonly owed = new Map<string, ChatPlace>();
  /** Runs whose agent acted outside a pause's hold, by run id (ids survive a rekey). */
  private readonly acted = new Set<string>();

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
   * @param place - The chat's folder and agent as the emitter knows them, for the row.
   * @returns Whether the record took the notice over.
   */
  claim(chatId: string, turnRef: number, place: ChatPlace = {}): boolean {
    const live = this.runs.liveRunOf(chatId);
    if (!live || (live.status !== 'started' && live.status !== 'running')) return false;
    if (live.runtimeTurnRef !== turnRef) return false;
    this.owed.set(live.id, place);
    return true;
  }

  /**
   * The run's agent acted, and no pause holds the turn: from here on no pause
   * can put it back (§4.7).
   *
   * @param runId - The run.
   */
  noteActed(runId: string): void {
    this.acted.add(runId);
  }

  /**
   * At `turn_end`, inside the transaction that recorded the ending: write the
   * notice now when the agent acted.
   *
   * @param run - The run, as stored after its ending was recorded.
   */
  atTurnEnd(run: TurnRun): void {
    if (this.acted.has(run.id)) this.write(run);
  }

  /**
   * At settle (or a graceful shutdown's end of a turn whose `turn_end` was
   * seen), inside the transaction that ended the run: write the notice it
   * still owes.
   *
   * @param run - The run, as stored after its move to `ended`.
   */
  atSettle(run: TurnRun): void {
    this.write(run);
    this.forget(run.id);
  }

  /**
   * The run owes nothing any more: a pause put its turn back, or it ended.
   *
   * @param runId - The run.
   */
  forget(runId: string): void {
    this.owed.delete(runId);
    this.acted.delete(runId);
  }

  /** Write the notice a run owes, once. */
  private write(run: TurnRun): void {
    const place = this.owed.get(run.id);
    if (place === undefined) return;
    this.effects.insert(turnFinishedNotice(run, run.ending ?? 'completed', this.now(), place));
    this.owed.delete(run.id);
  }
}
