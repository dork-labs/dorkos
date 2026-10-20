/**
 * Log each background `task_type` a warm process reports, once per type
 * (DOR-2064), split out of `persistent-dispatch.ts`.
 *
 * @module services/runtimes/claude-code/sessions/diagnostics/task-type-log
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../lib/logger.js';

/**
 * Log each background `task_type` the first time this process reports it
 * (spec `warm-process-lifecycle` D1, DOR-2064).
 *
 * Only `local_agent` is known to hold a process today, and whether a Monitor
 * appears on the level frame, and under what type, has never been watched. So
 * nothing here decides anything: it records what a real CLI actually sends,
 * once per type per process, so the next real session answers the question.
 * Defensive for the same reason `turn-liveness.ts` is: this runs inside the
 * pump's message loop, where a throw would read as the process dying.
 *
 * @param sessionId - The session the process belongs to
 * @param seen - The types already logged for this process
 * @param message - One frame the process just produced
 */
export function noteTaskTypes(sessionId: string, seen: Set<string>, message: SDKMessage): void {
  if (message.type !== 'system') return;
  if ((message as { subtype?: unknown }).subtype !== 'background_tasks_changed') return;
  const tasks = (message as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return;
  for (const task of tasks) {
    const taskType = (task as { task_type?: unknown } | null)?.task_type;
    if (typeof taskType !== 'string' || seen.has(taskType)) continue;
    seen.add(taskType);
    logger.info('[persistent-dispatch] a background task type appeared on this process', {
      session: sessionId,
      taskType,
    });
  }
}
