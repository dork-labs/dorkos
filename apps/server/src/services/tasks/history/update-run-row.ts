/**
 * The run row's one write shape, including the durable permission cap.
 * @module services/tasks/history/update-run-row
 */
import { eq } from 'drizzle-orm';
import { pulseRuns, type Db } from '@dorkos/db';
import type { TaskRun, TaskRunStatus, TaskRunOutcome } from '@dorkos/shared/types';
import { refusedToolsColumnOf, type RunCap } from './run-cap-column.js';

/** Fields that can be updated on a run. */
export interface RunUpdate {
  status?: TaskRunStatus;
  finishedAt?: string;
  durationMs?: number;
  outputSummary?: string;
  error?: string;
  sessionId?: string;
  /**
   * The tools this run was refused for want of somebody to approve them, in
   * the order they were first refused. Omitted leaves the stored list alone;
   * `[]` is a real answer and clears it.
   */
  refusedTools?: string[];
  /** The run runs capped, because its SKILL file changed (DOR-3703, M4). Never unset. */
  cappedAt?: RunCap;
  /** How much a `needs_attention` run got done (DOR-3123). */
  outcome?: TaskRunOutcome;
}

/** Write fields already guarded by TaskStore's terminal-state rule. */
export function updateRunRow(db: Db, id: string, existing: TaskRun, update: RunUpdate): void {
  db.update(pulseRuns)
    .set({
      status: update.status ?? existing.status,
      finishedAt: update.finishedAt ?? existing.finishedAt,
      durationMs: update.durationMs ?? existing.durationMs,
      output: update.outputSummary ?? existing.outputSummary,
      error: update.error ?? existing.error,
      sessionId: update.sessionId ?? existing.sessionId,
      // Serialized here rather than by the caller, so the one shape this
      // column holds is decided in one place (`run-cap-column.ts`). An absent
      // list leaves the stored value alone, as every field above does, and a
      // run's cap, once set, stays (DOR-3703, M4).
      refusedTools: refusedToolsColumnOf(
        update.refusedTools ?? existing.refusedTools,
        update.cappedAt ?? existing.cappedAt
      ),
      outcome: update.outcome ?? existing.outcome,
    })
    .where(eq(pulseRuns.id, id))
    .run();
}
