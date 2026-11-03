/**
 * The `commitments` gatherer (spec `heartbeats` §5, §12): the agent's open
 * promises due within a day, or overdue, and its open work gone quiet (DOR-3674).
 *
 * @module services/heartbeats/gatherers/commitments
 */
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import type { Change, GatherContext, Gatherer } from './types.js';
import { openWorkChanges, type OpenWorkReader } from './open-work.js';

/** How soon a promise has to be due to count. */
export const COMMITMENT_SOON_MS = 24 * 60 * 60 * 1000;

/** The slice of the commitment service this reads. */
export interface CommitmentReader {
  /** List commitments. */
  list(filter: { agentId?: string; state?: 'open' }, limit?: number): Commitment[];
}

/**
 * Build the gatherer. With `openWork`, it also names the agent's lanes and open promises that
 * went quiet (`open-work.ts`, DOR-3674).
 *
 * @param commitments - Where promises are read.
 * @param openWork - Where lanes and chat activity are read; absent reads promises only.
 */
export function createCommitmentsGatherer(
  commitments: CommitmentReader,
  openWork?: OpenWorkReader
): Gatherer {
  return async (ctx: GatherContext): Promise<Change[]> => {
    const now = ctx.now.getTime();
    const changes: Change[] = [];
    const open = commitments.list({ agentId: ctx.agent.id, state: 'open' }, 200);
    if (openWork) changes.push(...(await openWorkChanges(ctx, open, openWork)));
    for (const promise of open) {
      if (!promise.dueAt) continue;
      const due = Date.parse(promise.dueAt);
      if (Number.isNaN(due) || due - now > COMMITMENT_SOON_MS) continue;
      const overdue = due < now;
      changes.push({
        gatherer: 'commitments',
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
