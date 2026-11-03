/**
 * The notice a person gets when one of our agents changed how a running
 * schedule runs, above Don't ask, with no card (DOR-3703, final rulings,
 * condition 4). It goes on the notifications surface as a
 * `schedule.armed_by_agent` event: `notable`, never a "Needs you" row,
 * because nothing waits on the person. It names the old mode and the new one
 * and offers Undo, which only a person can use (`routes/task-mode-undo.ts`).
 *
 * The change stands only once the person is told: a notice that could not be
 * posted answers `false`, and the caller puts the old mode back.
 *
 * @module services/tasks/agent-mode/agent-mode-notice
 */
import { createHash } from 'node:crypto';
import type { Task } from '@dorkos/shared/types';
import {
  postScheduleArmed,
  resolveScheduleArmedPayload,
} from '../../notifications/emitters/schedule-armed.js';
import { resolveAgentIdForPath, resolveAgentNameForId } from '../../mesh/agent-path-lookup.js';
import { UNNAMED_PROPOSER } from '../../notifications/emitters/schedule-park.js';
import { logError, logger } from '../../../lib/logger.js';
import { recordAudit } from '../../audit/audit-trail.js';
import { TASK_SET_MODE_ACTION } from './agent-mode-actions.js';
import { SCHEDULED_RAISE_CODE } from './agent-mode-copy.js';
import type { AgentModeSources } from './agent-mode-decision.js';

/**
 * Tell the person an agent changed a running schedule's mode on its own.
 * Never throws; answers whether the notice was posted.
 *
 * @param change - The task after the change, the mode it had, who set it,
 *   who started the turn that did, and when.
 * @param sources - Where the runtime's mode names are read.
 */
export async function announceAgentModeChange(
  change: { after: Task; previousMode: string; setterPath?: string; startedBy: string; at: string },
  sources: Pick<AgentModeSources, 'declaredModes'>
): Promise<boolean> {
  try {
    const { after } = change;
    const declared = sources.declaredModes(after.runtime);
    const label = (mode: string) => declared?.values.find((m) => m.id === mode)?.label ?? mode;
    const setterId = change.setterPath ? resolveAgentIdForPath(change.setterPath) : undefined;
    const payload = await resolveScheduleArmedPayload(after);
    return await postScheduleArmed({
      ...payload,
      armedBy: (setterId ? resolveAgentNameForId(setterId) : undefined) ?? UNNAMED_PROPOSER,
      modeChange: {
        from: label(change.previousMode),
        to: label(after.permissionMode),
        startedBy: change.startedBy,
        at: change.at,
      },
    });
  } catch (err) {
    logger.warn('[tasks] could not post the notice for an agent’s mode change', logError(err));
    return false;
  }
}

/**
 * A scheduled run's raise was refused, and nothing changed (MUST-H): write it in
 * the audit log and tell the person who asked. Never throws, because the refusal
 * stands whether or not anyone could be told.
 *
 * @param asked - The task as it stands, the mode asked for, who asked, and who
 *   started the turn that did.
 * @param sources - Where the runtime's mode names are read.
 */
export async function reportRefusedRaise(
  asked: { task: Task; mode: string; setterPath?: string; startedBy: string },
  sources: Pick<AgentModeSources, 'declaredModes'>
): Promise<void> {
  const { task, mode, startedBy } = asked;
  const taskName = task.displayName ?? task.name;
  try {
    recordAudit({
      action: TASK_SET_MODE_ACTION,
      operation: 'modify',
      target: { type: 'task', id: task.id, name: taskName },
      outcome: 'refused',
      change: [
        { field: 'permissionMode', before: task.permissionMode, after: task.permissionMode },
        { field: 'asked', after: mode },
        { field: 'reason', after: SCHEDULED_RAISE_CODE },
        { field: 'startedBy', after: startedBy },
      ],
      summary: `Refused a raise of ${taskName}: ${startedBy} asked for ${mode}`,
    });
    const declared = sources.declaredModes(task.runtime);
    const label = (id: string) => declared?.values.find((m) => m.id === id)?.label ?? id;
    const setterId = asked.setterPath ? resolveAgentIdForPath(asked.setterPath) : undefined;
    const payload = await resolveScheduleArmedPayload(task);
    await postScheduleArmed({
      ...payload,
      armedBy: (setterId ? resolveAgentNameForId(setterId) : undefined) ?? UNNAMED_PROPOSER,
      refusedRaise: {
        from: label(task.permissionMode),
        to: label(mode),
        startedBy,
        at: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('[tasks] could not report a refused raise', logError(err));
  }
}

/**
 * Tell the person the task's own agent rewrote a running schedule's prompt
 * above Don't ask (M6). Never throws; answers whether the notice was posted.
 *
 * @param change - The task after the edit, the prompt it replaced, who wrote
 *   it, who started the turn, and when.
 */
export async function announceAgentPromptChange(change: {
  after: Task;
  previousPrompt: string;
  setterPath?: string;
  startedBy: string;
  at: string;
}): Promise<boolean> {
  try {
    const setterId = change.setterPath ? resolveAgentIdForPath(change.setterPath) : undefined;
    const payload = await resolveScheduleArmedPayload(change.after);
    return await postScheduleArmed({
      ...payload,
      armedBy: (setterId ? resolveAgentNameForId(setterId) : undefined) ?? UNNAMED_PROPOSER,
      promptChange: {
        startedBy: change.startedBy,
        at: change.at,
        fromHash: shortHashOf(change.previousPrompt),
        toHash: shortHashOf(change.after.prompt),
      },
    });
  } catch (err) {
    logger.warn('[tasks] could not post the notice for an agent’s prompt edit', logError(err));
    return false;
  }
}

/**
 * A prompt's short hash, as a notice and its audit row name it: the first 8
 * hex digits of its SHA-256.
 *
 * @param prompt - The prompt.
 */
export function shortHashOf(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 8);
}
