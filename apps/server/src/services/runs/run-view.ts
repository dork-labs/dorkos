/**
 * What every device reads of a chat's runs (spec `turns-survive-restarts`
 * §4.6, DOR-5212): the list the `run_update` event, the session snapshot and
 * `GET /api/sessions/:id/runs` all carry, and the announcer that puts it on
 * the chat's stream after every change of a run.
 *
 * Read from the record, never rebuilt from the stream: a turn whose process
 * died reads as ended, with its line, on every window. The list holds runs and
 * their lines only, never a turn's words (§4.1); a restored draft's words stay
 * in its queue row and ride `queue_update`.
 *
 * Emitted from here, never from turn code (§3.4): the computer face only
 * carries the event to the chat's stream (`emitRunUpdate`).
 *
 * @module services/runs/run-view
 */
import { LIVE_RUN_STATUSES, type ChatRun, type RunNotice } from '@dorkos/shared/run-schemas';
import { logger } from '../../lib/logger.js';
import { chatKeyOf, emitRunUpdate, waitingRowOrder } from '../session/turn-port/index.js';
import type { EffectStore } from './effects/effect-store.js';
import type { RunStore, TurnRun } from './run-store.js';

const LIVE: ReadonlySet<string> = new Set(LIVE_RUN_STATUSES);

/**
 * The line a person sees about a run's ending (§7.4), or `null`. Only the
 * case the record can already prove: a run whose process died and that
 * nothing continues. The other lines wait for recovery's facts (T15).
 *
 * @param run - The run.
 * @param continued - Whether a later run continues it.
 */
export function noticeOf(run: TurnRun, continued: boolean): RunNotice | null {
  const finished = run.status === 'ended' || run.status === 'settled';
  return finished && run.ending === 'process_died' && !continued ? 'restart_stopped' : null;
}

/**
 * One run as every device reads it.
 *
 * @param run - The run.
 * @param place - Its 1-based place among the chat's waiting runs, when it waits.
 * @param notice - Its line, if it has one.
 */
function viewOf(run: TurnRun, place: number | null, notice: RunNotice | null): ChatRun {
  return {
    id: run.id,
    chatSeq: run.chatSeq,
    status: run.status,
    openedBy: run.openedBy,
    attempt: run.attempt,
    waitReason: run.waitReason,
    queueMessageId: run.queueMessageId,
    queuePosition: place,
    waitingOnPerson: run.waitingOnPerson,
    ending: run.ending,
    notice,
    runtimeTurnRef: run.runtimeTurnRef,
    warnings: run.warnings,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

/**
 * A chat's runs as every device reads them, oldest first: its live run, its
 * waiting runs and, while nothing is live, the run that ended last (so its
 * ending and line show until the next turn starts). A waiting run's place is
 * derived now (§4.6): its queue row's order, else the order of its chat's
 * waiting starts.
 *
 * @param runs - The run store.
 * @param effects - The outbox, for the order of waiting starts.
 * @param chatId - The chat, by any id it answers to.
 */
export function chatRunsOf(runs: RunStore, effects: EffectStore, chatId: string): ChatRun[] {
  const { open, lastEnded, continued } = runs.shownRunsOf(chatId);
  const rows = waitingRowOrder(chatId);
  const starts = effects.openStartRunsOf(chatKeyOf(chatId));
  const placeOf = (run: TurnRun): number | null => {
    if (run.status !== 'queued') return null;
    const place =
      run.queueMessageId !== null ? rows.indexOf(run.queueMessageId) : starts.indexOf(run.id);
    return place === -1 ? null : place + 1;
  };
  const shown = open.map((run) => viewOf(run, placeOf(run), null));
  if (!lastEnded || open.some((run) => LIVE.has(run.status))) return shown;
  const ended = viewOf(lastEnded, null, noticeOf(lastEnded, continued));
  return [...shown, ended].sort((a, b) => a.chatSeq - b.chatSeq);
}

/**
 * Puts a chat's runs on its stream as `run_update` after a run changes, once
 * per chat per tick: the changes one transaction makes go out as one event,
 * read after it commits, so a rolled-back change is never announced.
 */
export class RunAnnouncer {
  private readonly due = new Set<string>();

  /**
   * Announce through `view`.
   *
   * @param view - The chat's runs as every device reads them.
   */
  constructor(private readonly view: (chatKey: string) => ChatRun[]) {}

  /**
   * A run was created or moved: announce its chat's runs after this tick.
   *
   * @param run - The run, as stored.
   */
  changed(run: Pick<TurnRun, 'sessionId'>): void {
    if (this.due.size === 0) queueMicrotask(() => this.flush());
    this.due.add(run.sessionId);
  }

  /** Announce every chat a change touched. Never throws. */
  private flush(): void {
    const chats = [...this.due];
    this.due.clear();
    for (const chatKey of chats) {
      try {
        emitRunUpdate(chatKey, () => this.view(chatKey));
      } catch (err) {
        logger.warn('[runs] could not announce a chat’s runs', {
          chatKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
