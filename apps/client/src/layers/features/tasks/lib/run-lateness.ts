import type { TaskRun } from '@dorkos/shared/types';

/**
 * How far past its occurrence a run has to start before its row says it ran
 * late. Seconds of drift between the occurrence and the start are ordinary
 * (the scheduler reads the agent before it opens the run), so anything under a
 * minute is on time.
 */
const LATE_AFTER_MS = 60_000;

/**
 * The server's cap on missed occurrences (`MISSED_TICKS_CAP` in the
 * scheduler's `timing/occurrence.ts`). A count at the cap means "this many or more".
 */
const MISSED_TICKS_CAP = 1000;

/**
 * How late a scheduled run started after the occurrence it stood for, as a
 * short duration ("12m", "1h 5m"), or `null` when it is not worth saying.
 *
 * `null` for a run that started within a minute of its occurrence, for a
 * skipped run (it never started, and its own line says why), and for a manual
 * run or one recorded before runs kept their occurrence (DOR-2718).
 *
 * @param run - The run to read.
 */
export function runLateness(run: TaskRun): string | null {
  if (run.status === 'skipped' || !run.scheduledFor || !run.startedAt) return null;
  const lateMs = Date.parse(run.startedAt) - Date.parse(run.scheduledFor);
  if (!(lateMs >= LATE_AFTER_MS)) return null;
  const minutes = Math.floor(lateMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * The line a run carries when earlier occurrences never ran because the
 * computer was asleep, or `null` when it missed none (DOR-2718).
 *
 * @param run - The run to read.
 */
export function missedRunsLine(run: TaskRun): string | null {
  const missed = run.missedTicks;
  if (!missed || missed <= 0) return null;
  if (missed >= MISSED_TICKS_CAP) return `Missed ${MISSED_TICKS_CAP}+ earlier runs while asleep.`;
  return `Missed ${missed} earlier ${missed === 1 ? 'run' : 'runs'} while asleep.`;
}
