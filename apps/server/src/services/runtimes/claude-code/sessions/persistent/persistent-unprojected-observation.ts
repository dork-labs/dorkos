/** Original private unprojected-window observation and bounded background-type DATA. */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../lib/logger.js';
import type { TurnWindow } from '../session-turn-windows.js';
import { carriesContent } from './persistent-dispatch-data.js';
import { requireOriginalPersistentObservationOwner } from '../persistent-dispatch.js';

/** Capture only an opaque selector; unrelated selectors fail before any original observation effect. */
export function createOriginalPersistentUnprojectedObservation(owner: object) {
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
  function noteTaskTypes(sessionId: string, seen: Set<string>, message: SDKMessage): void {
    requireOriginalPersistentObservationOwner(owner);
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

  /**
   * Read a window nothing will project, so its buffer empties and its close can
   * settle. Never yields the messages anywhere: see the module doc.
   */
  async function drainUnprojected(sessionId: string, window: TurnWindow): Promise<void> {
    requireOriginalPersistentObservationOwner(owner);
    const census: Record<string, number> = {};
    let dropped = 0;
    let content = 0;
    try {
      for await (const message of window.messages) {
        dropped += 1;
        census[message.type] = (census[message.type] ?? 0) + 1;
        if (carriesContent(message)) content += 1;
      }
    } catch (err) {
      logger.debug('[persistent-dispatch] a runtime window failed while draining', {
        sessionId,
        err,
      });
    }
    // The two cases are genuinely different and must not read alike. A window
    // holding only a `result` and a `system` line is bookkeeping the CLI
    // volunteered — routine, and a warning about it is noise that trains people
    // to ignore the log. A window holding model speech is words a person was owed
    // and never saw, which is the DOR-1314 loss, and it says so at the level that
    // gets read.
    if (content === 0) {
      logger.debug('[persistent-dispatch] drained a content-free turn nobody asked for', {
        sessionId,
        dropped,
        census,
      });
      return;
    }
    logger.error('[persistent-dispatch] dropped model output nobody could project', {
      sessionId,
      dropped,
      content,
      census,
    });
  }

  return Object.freeze({ noteTaskTypes, drainUnprojected });
}
