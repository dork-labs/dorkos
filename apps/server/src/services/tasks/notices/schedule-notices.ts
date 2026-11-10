/**
 * One quiet system line for a wake, failure streak or recovery (DOR-4078, DOR-4073).
 * Never sends a chat message, starts a turn or asks an agent to act.
 * @module services/tasks/notices/schedule-notices
 */
import { Cron } from 'croner';
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { RoomEntryBody } from '@dorkos/shared/room-schemas';
import {
  scheduleClockTime,
  scheduleFailureClause,
  scheduleFailureTitle,
  scheduleNextClause,
  scheduleNoticeName,
} from '@dorkos/shared/schedule-notice-copy';
import type { TaskStore } from '../task-store.js';
import { STALE_SKIP_REASON } from '../timing/occurrence.js';
import { failureReasonOf } from '../history/schedule-health.js';

/** Only the quiet room writer, a current store and the person's timezone are needed. */
export interface ScheduleNoticeDeps {
  store: TaskStore;
  post: (task: Task, body: RoomEntryBody) => void;
  timezone: () => string | null;
}

/** Schedule history owns streak state, including across restarts. */
export class ScheduleNotices {
  constructor(private readonly deps: ScheduleNoticeDeps) {}

  /** Attach to both write paths, including relay-side terminal writes. */
  observe(): void {
    this.deps.store.runNotices.scheduled = (run) => this.missed(run);
    this.deps.store.runNotices.terminal = (run) => this.finished(run);
  }

  private time(instant: Date): string {
    return scheduleClockTime(instant, this.deps.timezone());
  }

  private next(task: Task, label: 'run' | 'try'): string {
    if (!task.enabled || task.status !== 'active' || !task.cron) return '';
    try {
      const next = new Cron(task.cron, {
        paused: true,
        timezone: task.timezone ?? undefined,
      }).nextRun();
      return next ? ` ${scheduleNextClause(label, this.time(next))}` : '';
    } catch {
      return '';
    }
  }

  private missed(run: TaskRun): void {
    const stale = run.status === 'skipped' && run.error === STALE_SKIP_REASON;
    const count = (run.missedTicks ?? 0) + (stale ? 1 : 0);
    const task = this.deps.store.getTask(run.scheduleId);
    if (!task?.cron || !run.scheduledFor || count === 0) return;
    const latest = new Date(run.scheduledFor);
    const job = new Cron(task.cron, { paused: true, timezone: task.timezone ?? undefined });
    const shown = Math.min(count, 1000);
    const previous = job.previousRuns(shown, latest);
    const last = stale ? latest : previous[0];
    const first = stale ? (count === 1 ? latest : previous[shown - 2]) : previous[shown - 1];
    if (!first || !last) return;
    const when =
      count === 1
        ? this.time(last)
        : `${count >= 1000 ? '1000+' : count} runs (${this.time(first)}–${this.time(last)})`;
    this.deps.post(task, {
      text: `${scheduleNoticeName(task)} missed ${when}, likely because this computer was asleep.${this.next(task, 'run')}`,
      notice: 'schedule_missed',
    });
  }

  private finished(run: TaskRun): void {
    if (run.status !== 'failed' && run.status !== 'needs_attention' && run.status !== 'completed')
      return;
    const task = this.deps.store.getTask(run.scheduleId);
    if (!task) return;
    // A callback can run after a later row was written. Bound this snapshot to
    // this occurrence so a burst cannot turn the first failure into the second.
    const history = this.deps.store
      .listRuns({ taskId: task.id, limit: 1000 })
      .filter(
        (r) => r.id <= run.id && ['failed', 'needs_attention', 'completed'].includes(r.status)
      )
      .sort((a, b) => b.id.localeCompare(a.id));
    const older = history.filter((r) => r.id !== run.id);
    const streak = (rows: TaskRun[]) => {
      const completed = rows.findIndex((r) => r.status === 'completed');
      return completed < 0 ? rows.length : completed;
    };
    if (run.status === 'completed') {
      const recoveredAt = run.finishedAt ?? run.startedAt;
      // An older overlapping run completing must not claim recovery while
      // the schedule's newest runs are still failing.
      if (
        recoveredAt &&
        this.deps.store.runHistory()(task.id).health.state === 'ok' &&
        streak(older) >= 2
      )
        this.deps.post(task, {
          text: `${scheduleNoticeName(task)} ran again at ${this.time(new Date(recoveredAt))}.`,
        });
      return;
    }
    if (streak(history) !== 2) return;
    const reason = failureReasonOf({
      ...run,
      startedAt: run.startedAt ?? run.createdAt,
      error: run.error ?? null,
      outcome: run.outcome ?? null,
      refusedTools: run.refusedTools ? JSON.stringify(run.refusedTools) : null,
    });
    this.deps.post(task, {
      text: `${scheduleFailureTitle(task, reason.kind === 'tool_refused' || reason.kind === 'tools_refused')}: ${scheduleFailureClause(reason)}.${this.next(task, 'try')}`,
      notice: 'schedule_failed',
      scheduleRun: { scheduleId: task.id, runId: run.id },
    });
  }
}
