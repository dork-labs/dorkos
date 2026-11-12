/**
 * A person putting back what one of our agents changed on a running schedule
 * without asking: the mode it set, or the prompt its own-agent edit replaced
 * (DOR-3703, final rulings, condition 4, and the Nov 3 ruling, M6). The Undo on
 * the notice DorkOS posts for such a change. Only a person reaches this; the
 * route in front of it refuses every agent (`routes/task-mode-undo.ts`).
 *
 * It undoes exactly the change the notice named and nothing later: when the
 * task no longer holds what the agent wrote, there is nothing left to undo
 * and the task is left as it is.
 *
 * @module services/tasks/agent-mode/agent-mode-undo
 */
import type { MeshCore } from '@dorkos/mesh';
import type { Task } from '@dorkos/shared/types';
import type { TaskStore } from '../task-store.js';
import { applyTaskFileUpdate } from '../lifecycle/update-task-file.js';
import { auditScheduleUpdate } from '../approvals/schedule-owner.js';
import { recordAudit } from '../../audit/audit-trail.js';
import { TASK_SET_MODE_ACTION } from './agent-mode-actions.js';
import { liveAgentModeSources } from './agent-mode-sources.js';
import { isRaise } from './agent-mode-attest.js';
import { scheduleContentKey, taskWorkOf } from '../schedule-permission-clamp.js';
import { undoFileCapLift } from './file-cap/file-cap-person.js';
import { attestWrittenBody, fileEditsRunCapped } from './file-cap/file-cap-rule.js';

/** The change a notice named: when its mode change and its prompt edit were made. */
export interface NamedChange {
  /** The agent's mode change, by the time on its record. */
  modeAt?: string;
  /** The agent's prompt edit, by the time on its stored undo. */
  promptAt?: string;
  /** The agent's lift of a file cap (M4), by its time: Undo caps the task again. */
  fileLiftAt?: string;
}

/** The outcome of one undo: what it put back. */
export type AgentModeUndoOutcome =
  | { ok: true; task: Task; restored: string }
  | { ok: false; status: 400 | 404 | 409 | 500; body: Record<string, unknown> };

/** Where the undo reads and writes. */
type UndoDeps = {
  store: Pick<TaskStore, 'getTask' | 'updateTask' | 'approvals'>;
  dorkHome: string;
  meshCore?: MeshCore;
};

/**
 * What a refused Undo tells the person (M9): it was not undone, the task
 * changed since the notice, and what it runs as now; the notice adds the link
 * to open it. Never a silent no.
 *
 * @param task - The task as it stands.
 * @param modeLabel - What its mode is called on its runtime.
 */
function nothingToUndo(task: Task, modeLabel: string): Record<string, unknown> {
  return {
    error: 'Nothing to undo',
    code: 'nothing_to_undo',
    // The client puts its own "Open it to check." link after this sentence.
    message: `Not undone: this task changed since this notice. It now runs as ${modeLabel}.`,
    taskId: task.id,
    permissionMode: task.permissionMode,
  };
}

/**
 * What the named change replaced, while the task still holds exactly what that
 * change wrote: its mode (never one looser than the task runs at now, M9) and
 * its prompt (M6). Empty when nothing of it is left to undo.
 *
 * @param task - The task as it stands.
 * @param store - Where the prompt an edit replaced is kept.
 * @param named - The change the notice named.
 */
function undoableOf(
  task: Task,
  store: UndoDeps['store'],
  named: NamedChange
): { permissionMode?: Task['permissionMode']; prompt?: string } {
  const record = task.agentModeRecord;
  const declared = liveAgentModeSources(undefined).declaredModes(task.runtime);
  const mode =
    named.modeAt !== undefined &&
    record?.kind === 'set_mode' &&
    record.at === named.modeAt &&
    record.previousMode &&
    record.mode === task.permissionMode &&
    declared !== undefined &&
    !isRaise(declared, record.previousMode, task.permissionMode)
      ? record.previousMode
      : undefined;
  const undo = store.approvals.agentModeColumnOf(task.id).promptUndo;
  const prompt =
    named.promptAt !== undefined && undo?.at === named.promptAt && undo.written === task.prompt
      ? undo.previous
      : undefined;
  return { ...(mode ? { permissionMode: mode } : {}), ...(prompt !== undefined ? { prompt } : {}) };
}

/** A mode's name on the task's runtime, for the person. */
function modeLabelOf(task: Task): string {
  const declared = liveAgentModeSources(undefined).declaredModes(task.runtime);
  return declared?.values.find((m) => m.id === task.permissionMode)?.label ?? task.permissionMode;
}

/**
 * Put back exactly what the named change replaced, its prompt and its mode,
 * and only while the task still holds what that change wrote (M9): the SKILL
 * file first, then the row, then the task's own records of the change are
 * cleared. The row is read again, with no await before its write, so a change
 * that landed while the file was written is never undone over. It never puts
 * back a mode looser than the one the task runs at now.
 *
 * A person's Undo holds the task to the mode it put back (an agent's raise
 * above it asks them until they raise it themselves, M2), and approves the
 * prompt it put back as theirs; putting back only a mode approves no content
 * (SB2).
 *
 * @param deps - The store, the data directory and Mesh.
 * @param id - The schedule.
 * @param named - The change the notice named.
 * @param byPerson - Whether a person asked for it, rather than DorkOS undoing
 *   a change nobody could be told about.
 */
export async function undoAgentModeChange(
  deps: UndoDeps,
  id: string,
  named: NamedChange,
  byPerson = false
): Promise<AgentModeUndoOutcome> {
  const { store } = deps;
  if (named.fileLiftAt !== undefined) {
    const lift = undoFileCapLift(store, id, named.fileLiftAt);
    return lift.ok ? { ok: true, task: lift.task, restored: 'the file cap' } : lift;
  }
  const existing = store.getTask(id);
  if (!existing) return { ok: false, status: 404, body: { error: 'Scheduled task not found' } };
  const data = undoableOf(existing, store, named);
  if (Object.keys(data).length === 0) {
    return { ok: false, status: 409, body: nothingToUndo(existing, modeLabelOf(existing)) };
  }
  const file = await applyTaskFileUpdate(
    { dorkHome: deps.dorkHome, ...(deps.meshCore && { meshCore: deps.meshCore }) },
    { existing, data }
  );
  if (!file.ok) {
    return {
      ok: false,
      status: file.status,
      body: { error: file.error, ...(file.code !== undefined && { code: file.code }) },
    };
  }
  const now = store.getTask(id);
  if (!now) return { ok: false, status: 404, body: { error: 'Scheduled task not found' } };
  if (JSON.stringify(undoableOf(now, store, named)) !== JSON.stringify(data)) {
    return { ok: false, status: 409, body: nothingToUndo(now, modeLabelOf(now)) };
  }
  const updated = store.updateTask(id, data);
  if (!updated) return { ok: false, status: 404, body: { error: 'Scheduled task not found' } };
  if (data.permissionMode) store.approvals.recordAgentModeChange(id, null);
  if (data.prompt !== undefined) store.approvals.setPromptUndo(id, null);
  if (byPerson) {
    if (data.permissionMode) store.approvals.setPersonFloor(id, data.permissionMode);
    // Only content the person put back is theirs, and only as it now stands: a
    // mode-only Undo approves no prompt it never showed them (SB2, M1).
    if (data.prompt !== undefined) {
      store.approvals.recordPersonApproval(id, scheduleContentKey(taskWorkOf(updated)));
      // The prompt a person put back is theirs, file included: no false cap (M4).
      if (fileEditsRunCapped(updated))
        await attestWrittenBody(store, updated, data.prompt, 'person');
    }
  }
  auditScheduleUpdate(now, updated);
  const restored = [data.prompt !== undefined ? 'the old prompt' : '', data.permissionMode ?? '']
    .filter(Boolean)
    .join(' and ');
  return { ok: true, task: store.getTask(id) ?? updated, restored };
}

/**
 * Undo an agent's mode change the person could not be told about (final
 * rulings, condition 4: the change stands only once it is audited AND the
 * person is told). The same path as a person's Undo; should even that fail,
 * the task is parked, so it never runs at a mode nobody was told of. The
 * audit row says it was reverted and why. Returns whether the mode was put back.
 *
 * @param deps - The store, the data directory and Mesh.
 * @param after - The task as the agent's change left it.
 * @param previousMode - The mode it had before.
 * @param named - The change to put back: the one just made.
 */
export async function revertUntoldAgentMode(
  deps: Parameters<typeof undoAgentModeChange>[0],
  after: Task,
  previousMode: string,
  named: NamedChange
): Promise<boolean> {
  let restored: boolean;
  try {
    restored = (await undoAgentModeChange(deps, after.id, named)).ok;
  } catch {
    restored = false;
  }
  // Could not put it back: it waits for a person rather than run untold.
  if (!restored) deps.store.updateTask(after.id, { status: 'pending_approval' });
  const label = after.displayName ?? after.name;
  recordAudit({
    action: TASK_SET_MODE_ACTION,
    operation: 'modify',
    target: { type: 'task', id: after.id, name: label },
    outcome: 'refused',
    change: [
      {
        field: 'permissionMode',
        before: after.permissionMode,
        after: restored ? previousMode : after.permissionMode,
      },
      { field: 'reverted', after: restored ? 'restored' : 'parked' },
      { field: 'reason', after: 'person_not_told' },
    ],
    summary: `Reverted an agent's change to ${label}: the person could not be told`,
  });
  return restored;
}
