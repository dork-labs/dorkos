/**
 * Turns a finished scheduled run into a notification (DOR-240, folded into the
 * notification pipeline by DOR-1383).
 *
 * This replaces `TaskCompletionNotifier`, and the delivery policy it carried is
 * now declared on the `run.completed` registry entry rather than implemented
 * here: failures always reach out, successes only where the operator switched
 * the binding's "tell me when a task finishes" on, cancellations never — the
 * operator cancelled it, so they already know. What is NEW is that every finished
 * run now leaves a row in the inbox whether or not any chat integration could
 * carry it, which on a stock install is the difference between a record and
 * silence.
 *
 * @module services/notifications/emitters/run-completed
 */
import type { Task, TaskRun } from '@dorkos/shared/types';
import { formatDuration } from '../../../lib/format-duration.js';
import { readableToolName } from '@dorkos/shared/run-refusals';
import { notify } from '../notification-service.js';
import { ONCE_PER_STREAK_LINE, OPEN_TO_FIX_LINE, runFailureReason } from '../run-completed-copy.js';

/** Relay `from` principal for automatic task-completion notifications. */
const TASK_NOTIFIER_PRINCIPAL = 'relay.system.tasks.notifier';

/** Max characters for a completion message body (glanceable, no wall of text). */
const MESSAGE_MAX_CHARS = 200;

/**
 * Max characters for a failing run's message. Longer than a success's because
 * it carries four fixed parts (DOR-3123) — a reason, the fix and the no-repeat
 * promise — and the reason is the only one that may be cut.
 */
const FAILING_MESSAGE_MAX_CHARS = 280;

/**
 * How long a completion ping may live in the relay pipeline.
 *
 * A terminal leaf — nothing downstream takes a turn off it — so a minimal budget
 * is correct, and the pipeline gate rejects and dead-letters rather than
 * dispatching if it is ever over.
 */
const PUBLISH_BUDGET = { maxHops: 2, callBudgetRemaining: 1 } as const;

/** How long the publish stays valid for, from the moment it is handed over. */
const PUBLISH_TTL_MS = 30_000;

/**
 * Raise the notification for a run that reached a terminal status.
 *
 * Never throws: the run-terminal hook is on the write path for run persistence,
 * and a notification problem must never be able to corrupt it.
 *
 * **One notice per failing streak** (DOR-3123, PM's call on FB-67): when the
 * caller says how long the schedule has been failing, only the run that STARTS
 * the streak raises a notice, and that notice says it will not repeat. Every
 * run still records its true status in run history; only the notice is spared.
 * A completed run ends the streak, so the next failure raises a notice again.
 * Without `streak` every failing run raises one, as before.
 *
 * @param run - The run that finished.
 * @param task - Its task, when the hook knew it.
 * @param streak - How many finished runs in a row have now failed, this one
 *   included (`Task.health.streak`), when the caller can read it.
 */
export async function notifyRunCompleted(
  run: TaskRun,
  task: Task | null,
  streak?: number
): Promise<void> {
  // Cancellations are the operator's own action — they already know.
  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'needs_attention') {
    return;
  }
  const failing = run.status !== 'completed';
  // Later runs of a streak the person was already told about stay quiet.
  if (failing && streak !== undefined && streak > 1) return;
  const oncePerStreak = failing && streak !== undefined;

  const taskName = task?.displayName?.trim() || task?.name || 'Scheduled task';
  const duration = run.durationMs != null ? formatDuration(run.durationMs) : undefined;
  const detail =
    run.status === 'completed'
      ? firstLine(run.outputSummary)
      : (firstLine(run.error) ?? firstLine(run.outputSummary));

  await notify(
    'run.completed',
    {
      runId: run.id,
      taskId: run.scheduleId,
      taskName,
      ...(task?.agentId ? { agentId: task.agentId } : {}),
      status: run.status,
      ...(run.outcome ? { outcome: run.outcome } : {}),
      ...(run.status === 'needs_attention' && run.refusedTools?.length
        ? { refusedTools: [...new Set(run.refusedTools.map(readableToolName))] }
        : {}),
      ...(oncePerStreak ? { oncePerStreak: true as const } : {}),
      ...(duration ? { duration } : {}),
      ...(detail ? { detail } : {}),
      channelMessage: formatCompletionMessage(task, run, oncePerStreak),
    },
    {
      relay: {
        fromPrincipal: TASK_NOTIFIER_PRINCIPAL,
        publishBudget: { ...PUBLISH_BUDGET, ttl: Date.now() + PUBLISH_TTL_MS },
        // No DorkOS-DM fallback and no hourly budget, both as DOR-240 shipped:
        // this is the system reporting on work the operator scheduled, not an
        // agent choosing to interrupt them, so it neither opens a conversation
        // nor spends an agent's allowance to say so.
      },
    }
  );
}

/**
 * First non-empty line of a block of text, trimmed. Keeps a completion message
 * to a single glanceable sentence rather than shipping full run output.
 */
function firstLine(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * Build the sentence a chat integration says (writing-for-humans; control-panel
 * tone).
 *
 * A success keeps the shape DOR-240 shipped: a tick, the task name, how long it
 * took and the first line of what it said. A run that did not do its job says
 * what the inbox notice says, in the same four parts (DOR-3123): a padlock for
 * a refusal or a cross for a failure, "{Schedule} needs attention.", the
 * Schedules row's reason, the one fix, and the no-repeat line on a streak's one
 * notice. No log wording and no run time: neither helps a person fix it.
 *
 * @param task - The run's task, for its display name (may be null).
 * @param run - The finished run, for status, refusals, duration and output/error.
 * @param oncePerStreak - Whether this is the one notice of a failing streak,
 *   which says it will not repeat (DOR-3123).
 */
export function formatCompletionMessage(
  task: Task | null,
  run: TaskRun,
  oncePerStreak = false
): string {
  const name = task?.displayName?.trim() || task?.name || 'Scheduled task';

  if (run.status === 'failed' || run.status === 'needs_attention') {
    // The same parts as the inbox notice, in the same order (DOR-3123): what
    // happened, why, the one fix, and — on a streak's one notice — that no
    // more will follow. Only the reason is ever cut, so the fix and the
    // promise always arrive whole.
    const mark = run.status === 'failed' ? '✕' : '🔒';
    const reason = runFailureReason({
      runId: run.id,
      taskId: run.scheduleId,
      taskName: name,
      status: run.status,
      ...(run.outcome ? { outcome: run.outcome } : {}),
      refusedTools: [...new Set((run.refusedTools ?? []).map(readableToolName))],
      ...(firstLine(run.error) ? { detail: firstLine(run.error) } : {}),
      channelMessage: '',
    });
    const head = `${mark} ${name} needs attention.`;
    const tail = ` ${OPEN_TO_FIX_LINE}${oncePerStreak ? ` ${ONCE_PER_STREAK_LINE}` : ''}`;
    const room = FAILING_MESSAGE_MAX_CHARS - head.length - tail.length - 1;
    return `${head} ${truncate(reason, Math.max(room, 1))}${tail}`;
  }
  const duration = run.durationMs != null ? formatDuration(run.durationMs) : null;
  const detail = firstLine(run.outputSummary);
  const body =
    `✅ ${name} — done${duration ? ` in ${duration}` : ''}.` + (detail ? ` ${detail}` : '');
  return truncate(body, MESSAGE_MAX_CHARS);
}

/** Truncate to `max` characters, appending an ellipsis when it had to cut. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
