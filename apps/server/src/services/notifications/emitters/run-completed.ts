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
import { ONCE_PER_STREAK_LINE } from '../run-completed-copy.js';

/** Relay `from` principal for automatic task-completion notifications. */
const TASK_NOTIFIER_PRINCIPAL = 'relay.system.tasks.notifier';

/** Max characters for a completion message body (glanceable, no wall of text). */
const MESSAGE_MAX_CHARS = 200;

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
 * Shape: one status emoji + task name + duration + the first line of output (on
 * success) or error (on a failed or needs-attention run), truncated to keep it
 * glanceable. Kept exactly as DOR-240 shipped it rather than rebuilt from the
 * inbox row's title and body: a phone message and an inbox row are not the same
 * sentence, and this one is already tuned.
 *
 * @param task - The run's task, for its display name (may be null).
 * @param run - The finished run, for status, duration, and output/error.
 * @param oncePerStreak - Whether this is the one notice of a failing streak,
 *   which says it will not repeat (DOR-3123).
 */
export function formatCompletionMessage(
  task: Task | null,
  run: TaskRun,
  oncePerStreak = false
): string {
  const once = oncePerStreak ? ` ${ONCE_PER_STREAK_LINE}` : '';
  const name = task?.displayName?.trim() || task?.name || 'Scheduled task';
  const duration = run.durationMs != null ? formatDuration(run.durationMs) : null;

  let body: string;
  if (run.status === 'failed') {
    const detail = firstLine(run.error) ?? firstLine(run.outputSummary);
    body =
      `⚠️ ${name} — failed${duration ? ` after ${duration}` : ''}.${once}` +
      (detail ? ` ${detail}` : '');
  } else if (run.status === 'needs_attention') {
    // Not the tick and not the warning triangle: the run did not break, and it
    // did not do all of its job either. What it needs is permission, so the
    // sentence says that and nothing else (DOR-2101, DOR-3123).
    // The detail is the run's own refusal sentence, which already ends "nobody
    // was there to approve them" — so the lead says what happened and lets the
    // detail name the tools, instead of saying the same thing twice
    // (DOR-2101 review).
    const detail = firstLine(run.error) ?? firstLine(run.outputSummary);
    body =
      `🔒 ${name} — ${run.outcome === 'nothing_done' ? 'used none of its tools' : 'was refused a tool'}${duration ? ` in ${duration}` : ''}.${once}` +
      (detail ? ` ${detail}` : '');
  } else {
    const detail = firstLine(run.outputSummary);
    body = `✅ ${name} — done${duration ? ` in ${duration}` : ''}.` + (detail ? ` ${detail}` : '');
  }

  return truncate(body, MESSAGE_MAX_CHARS);
}

/** Truncate to `max` characters, appending an ellipsis when it had to cut. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
