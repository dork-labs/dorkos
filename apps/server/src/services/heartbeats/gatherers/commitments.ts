/**
 * The `commitments` gatherer (spec `heartbeats` §5, §12): the agent's open
 * promises due within a day, or overdue.
 *
 * @module services/heartbeats/gatherers/commitments
 */
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import type { Change, GatherContext, Gatherer } from './types.js';

/** How soon a promise has to be due to count. */
export const COMMITMENT_SOON_MS = 24 * 60 * 60 * 1000;

/** The slice of the commitment service this reads. */
export interface CommitmentReader {
  /** List commitments. */
  list(filter: { agentId?: string; state?: 'open' }, limit?: number): Commitment[];
}

/**
 * Build the gatherer.
 *
 * @param commitments - Where promises are read.
 */
export function createCommitmentsGatherer(commitments: CommitmentReader): Gatherer {
  return async (ctx: GatherContext): Promise<Change[]> => {
    const now = ctx.now.getTime();
    const changes: Change[] = [];
    for (const promise of commitments.list({ agentId: ctx.agent.id, state: 'open' }, 200)) {
      if (!promise.dueAt) continue;
      const due = Date.parse(promise.dueAt);
      if (Number.isNaN(due) || due - now > COMMITMENT_SOON_MS) continue;
      const overdue = due < now;
      changes.push({
        gatherer: 'commitments',
        key: `commitment:${promise.id}`,
        summary: overdue
          ? `Overdue since ${promise.dueAt}: ${promise.what}`
          : `Due ${promise.dueAt}: ${promise.what}`,
        at: promise.dueAt,
        ref: { kind: 'commitment', id: promise.id },
        signal: overdue ? 'commitment-overdue' : 'commitment-due',
      });
    }
    return changes;
  };
}
