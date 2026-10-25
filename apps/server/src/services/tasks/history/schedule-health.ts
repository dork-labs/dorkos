/**
 * Whether each schedule's last finished run did its job (DOR-3123, spec
 * `schedules-failing` §1.2), so the Schedules list, its count and its Failing
 * filter all read one answer the server worked out.
 *
 * @module services/tasks/history/schedule-health
 */
import { asc, desc, inArray } from 'drizzle-orm';
import { pulseRuns, type Db } from '@dorkos/db';
import type { TaskFailureReason, TaskHealth } from '@dorkos/shared/types';

/**
 * The statuses that say how a run went. `skipped`, `cancelled` and `running`
 * are left out on purpose: a tick that never ran, a run somebody stopped and a
 * run still going say nothing about whether the schedule works, so they
 * neither start a failing streak nor clear one. `timeout` exists only in the
 * DB column's enum and no writer produces it; a row carrying it finished
 * without doing its job, so it counts as a failure.
 */
const FINISHED_STATUSES = ['completed', 'needs_attention', 'failed', 'timeout'] as const;

/** The health of a schedule with no failing run to report. */
export const HEALTHY: TaskHealth = {
  state: 'ok',
  reason: null,
  since: null,
  streak: 0,
  lastRunId: null,
};

/**
 * The prefix `run-outcome` puts on an expired sign-in's line ("Sign in again:
 * …"), which is how a stored row says the runtime's credential was the cause.
 */
const SIGN_IN_PREFIX = 'Sign in again:';

/** How long an error line is kept; the row shows one line and truncates. */
const MAX_MESSAGE_CHARS = 200;

/** One finished run, as much of it as health needs. */
interface FinishedRun {
  id: string;
  scheduleId: string;
  status: string;
  startedAt: string;
  error: string | null;
  refusedTools: string | null;
  outcome: string | null;
}

/**
 * The first line of a stored error, trimmed, or `null` when there is none.
 *
 * @param error - The run's stored error.
 */
function firstLine(error: string | null): string | null {
  const line = error?.split('\n')[0]?.trim();
  return line ? line.slice(0, MAX_MESSAGE_CHARS) : null;
}

/**
 * The refused tools off a stored row, defensively: a corrupted value reads as
 * none rather than costing the whole list.
 *
 * @param raw - The `refused_tools` column as stored.
 */
function readTools(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')
      ? [...new Set(parsed as string[])]
      : [];
  } catch {
    return [];
  }
}

/**
 * Why a failing run failed, in the catalogue every surface draws from.
 *
 * @param run - The schedule's latest finished run, which failed.
 */
export function failureReasonOf(run: FinishedRun): TaskFailureReason {
  const tools = readTools(run.refusedTools);
  const message = firstLine(run.error);
  if (run.status === 'needs_attention' && tools.length > 0) {
    return {
      kind: tools.length === 1 ? 'tool_refused' : 'tools_refused',
      tools,
      nothingDone: run.outcome === 'nothing_done',
      message: null,
    };
  }
  if (message?.startsWith(SIGN_IN_PREFIX)) {
    return { kind: 'signin_needed', tools: [], nothingDone: false, message };
  }
  return { kind: 'error', tools: [], nothingDone: false, message };
}

/**
 * Fold one schedule's finished runs, newest first, into its health.
 *
 * Failing when the newest is not `completed`; the streak is every run back to
 * the last `completed` one, and `since` is when the oldest of them started.
 *
 * @param runs - The schedule's finished runs, newest first.
 */
export function healthOf(runs: readonly FinishedRun[]): TaskHealth {
  const latest = runs[0];
  if (!latest || latest.status === 'completed') return HEALTHY;
  let streak = 0;
  for (const run of runs) {
    if (run.status === 'completed') break;
    streak += 1;
  }
  return {
    state: 'failing',
    reason: failureReasonOf(latest),
    since: runs[streak - 1]!.startedAt,
    streak,
    lastRunId: latest.id,
  };
}

/**
 * Every schedule's health, keyed by schedule id. A schedule that never
 * finished a run is absent, and reads as {@link HEALTHY}.
 *
 * One query for every schedule. Run history is pruned per schedule, so the
 * rows it reads stay few.
 *
 * @param db - The DorkOS database.
 */
export function scheduleHealth(db: Db): Map<string, TaskHealth> {
  const rows = db
    .select({
      id: pulseRuns.id,
      scheduleId: pulseRuns.scheduleId,
      status: pulseRuns.status,
      startedAt: pulseRuns.startedAt,
      error: pulseRuns.error,
      refusedTools: pulseRuns.refusedTools,
      outcome: pulseRuns.outcome,
    })
    .from(pulseRuns)
    .where(inArray(pulseRuns.status, [...FINISHED_STATUSES]))
    .orderBy(asc(pulseRuns.scheduleId), desc(pulseRuns.startedAt), desc(pulseRuns.id))
    .all();
  const bySchedule = new Map<string, FinishedRun[]>();
  for (const row of rows) {
    const list = bySchedule.get(row.scheduleId) ?? [];
    list.push(row);
    bySchedule.set(row.scheduleId, list);
  }
  const health = new Map<string, TaskHealth>();
  for (const [scheduleId, runs] of bySchedule) health.set(scheduleId, healthOf(runs));
  return health;
}
