/**
 * The `schedules` gatherer (spec `heartbeats` §5): runs of the agent's own
 * schedules since its last beat that failed or stopped for a person.
 *
 * A task run has no "parked" status; `needs_attention` (it was refused a tool
 * nobody was there to approve, DOR-3123) is the parked case.
 *
 * @module services/heartbeats/gatherers/schedules
 */
import type { Change, GatherContext, Gatherer } from './types.js';

/** A run, as this gatherer reads it. */
export interface OwnRun {
  /** The run id. */
  id: string;
  /** The schedule's name. */
  taskName: string;
  /** `failed` or `needs_attention`. */
  status: 'failed' | 'needs_attention';
  /** When it ended (ISO 8601). */
  at: string;
}

/** Reads an agent's failed or needs-attention runs since a moment. */
export type OwnRunReader = (agentId: string, sinceIso: string | null) => OwnRun[];

/**
 * Build the gatherer.
 *
 * @param readRuns - Where runs are read.
 */
export function createSchedulesGatherer(readRuns: OwnRunReader): Gatherer {
  return async (ctx: GatherContext): Promise<Change[]> =>
    readRuns(ctx.agent.id, ctx.since).map((run) => ({
      gatherer: 'schedules',
      key: `run:${run.id}`,
      summary:
        run.status === 'failed'
          ? `The "${run.taskName}" schedule failed.`
          : `The "${run.taskName}" schedule was refused a tool and needs a person.`,
      at: run.at,
      ref: { kind: 'run', id: run.id },
      signal: 'run-failed',
    }));
}
