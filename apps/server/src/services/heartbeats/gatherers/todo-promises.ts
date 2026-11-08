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
      if (!promise.dueAt) continue;
      const due = Date.parse(promise.dueAt);
      if (Number.isNaN(due) || due - now > TODO_SOON_MS) continue;
      const overdue = due < now;
      changes.push({
        gatherer: 'todos',
        key: `commitment:${promise.id}`,
        // Its words stay out of the summary: they can be somebody else's (a to-do, DOR-3088), and
        // the prompt shows them only inside the fenced open-promises list, by this id.
        summary: overdue
          ? `Overdue since ${promise.dueAt}: promise ${promise.id}`
          : `Due ${promise.dueAt}: promise ${promise.id}`,
        at: promise.dueAt,
        ref: { kind: 'commitment', id: promise.id },
        signal: overdue ? 'commitment-overdue' : 'commitment-due',
      });
    }
    return changes;
  };
}
