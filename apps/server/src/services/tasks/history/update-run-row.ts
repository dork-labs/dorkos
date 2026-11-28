/**
 * The run row's one write shape, including the durable permission cap.
 * @module services/tasks/history/update-run-row
 */
import { eq } from 'drizzle-orm';
import { pulseRuns, type Db } from '@dorkos/db';
import type { TaskRun, TaskRunStatus, TaskRunOutcome } from '@dorkos/shared/types';
import { RUN_LINE } from '@dorkos/shared/schedule-notice-copy';
import { refusedToolsColumnOf, type RunCap, type RunCapFile } from './run-cap-column.js';

/** The status and line a run is ended with when nothing is left to read its turn. */
export interface RunEndingFields {
  status: Extract<TaskRunStatus, 'completed' | 'failed' | 'cancelled'>;
  /** The line a person reads, or `null` for none. */
  error: string | null;
}

/** A run a restart interrupted. The notice reads this opening back as "DorkOS restarted" (DOR-4121). */
export const INTERRUPTED_BY_RESTART: RunEndingFields = {
  status: 'failed',
  error: RUN_LINE.serverRestart,
};

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
  /** The file that capped it and its two hashes (DOR-5060). Never unset. */
  cappedFile?: RunCapFile;
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
        update.cappedAt ?? existing.cappedAt,
        update.cappedFile ?? existing.cappedFile
      ),
      outcome: update.outcome ?? existing.outcome,
    })
    .where(eq(pulseRuns.id, id))
    .run();
}
