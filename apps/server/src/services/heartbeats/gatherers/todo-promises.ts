/**
 * The `todos` gatherer (spec `heartbeats` §5, §12): the agent's open
 * promises due within a day, or overdue, and its open work gone quiet (DOR-3674).
 *
 * @module services/heartbeats/gatherers/todo-promises
 */
import type { TodoPromise } from '@dorkos/shared/todo-promise-schemas';
import type { Change, GatherContext, Gatherer } from './types.js';
import { openWorkChanges, type OpenWorkReader } from './open-work.js';

/** How soon a promise has to be due to count. */
export const TODO_SOON_MS = 24 * 60 * 60 * 1000;

/** The slice of the to-do service this reads. */
export interface TodoReader {
  /** List to-dos. */
  list(filter: { agentId?: string; state?: 'open' }, limit?: number): TodoPromise[];
  /**
   * The last wake for a promise's current date (DOR-3034): start or check-in, when, and whether a
   * person's Not yet caused it. Absent where wakes are not tracked; then a due promise reads as
   * due, as before.
   */
  lastWakeOf?(id: string): { phase: 'start' | 'checkin'; at: string; notYet: boolean } | null;
}

/**
 * Build the gatherer. With `openWork`, it also names the agent's lanes and open promises that
 * went quiet (`open-work.ts`, DOR-3674).
 *
 * @param to-dos - Where promises are read.
 * @param openWork - Where lanes and chat activity are read; absent reads promises only.
 */
export function createTodosGatherer(todoPromises: TodoReader, openWork?: OpenWorkReader): Gatherer {
  return async (ctx: GatherContext): Promise<Change[]> => {
    const now = ctx.now.getTime();
    const changes: Change[] = [];
    const open = todoPromises.list({ agentId: ctx.agent.id, state: 'open' }, 200);
    if (openWork) changes.push(...(await openWorkChanges(ctx, open, openWork)));
    for (const promise of open) {
      const due = promise.dueAt ? Date.parse(promise.dueAt) : NaN;
      const overdue = !Number.isNaN(due) && due < now;
      const wake = todoPromises.lastWakeOf?.(promise.id) ?? null;
      // A wake counts as news to the beat it woke (DOR-3034): a start or check-in before the date,
      // or any wake a person's Not yet caused, dated or not and past the date or not. Its key
      // carries the wake's moment, so a later wake is never read as one already seen.
      const news = wake !== null && (wake.notYet || !overdue);
      if (!news && (Number.isNaN(due) || due - now > TODO_SOON_MS)) continue;
      const when = promise.dueAt ? `due ${promise.dueAt}` : 'no date';
      changes.push({
        gatherer: 'todos',
        key: news
          ? `commitment:${promise.id}:${wake.phase}:${wake.at}`
          : `commitment:${promise.id}`,
        // Its words stay out of the summary: they can be somebody else's (a to-do, DOR-3088), and
        // the prompt shows them only inside the fenced open-promises list, by this id.
        summary: news
          ? wake.notYet
            ? `Not done yet, says the person, ${when}: promise ${promise.id}`
            : wake.phase === 'start'
              ? `Start now, ${when}: promise ${promise.id}`
              : `Check in, ${when}: promise ${promise.id}`
          : overdue
            ? `Overdue since ${promise.dueAt}: promise ${promise.id}`
            : `Due ${promise.dueAt}: promise ${promise.id}`,
        at: news ? wake.at : promise.dueAt!,
        ref: { kind: 'commitment', id: promise.id },
        signal: news ? 'commitment-start' : overdue ? 'commitment-overdue' : 'commitment-due',
      });
    }
    return changes;
  };
}
