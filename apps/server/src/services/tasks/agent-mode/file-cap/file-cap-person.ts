/**
 * A person's two acts on a file cap (DOR-3703, M4): Undo on the notice an
 * agent's lift posted, which caps the task again, and approving the file as
 * it is now, which lifts the cap. Only a person reaches either; the routes in
 * front refuse every agent (`routes/task-mode-undo.ts`, `routes/task-file-approve.ts`).
 *
 * Each acts only on what it names: the Undo on the lift its notice named,
 * while the task still holds the file that lift attested; the approval on the
 * cap the person saw, while the file still hashes to what that cap recorded.
 *
 * @module services/tasks/agent-mode/file-cap/file-cap-person
 */
import type { Task } from '@dorkos/shared/types';
import { recordAudit } from '../../../audit/audit-trail.js';
import type { TaskStore } from '../../task-store.js';
import { attestationOf } from './file-cap-rule.js';
import { readFileState } from './file-hash.js';
import { FILE_CAP_ACTION } from './run-cap.js';

/** What either act answers. */
export type FileCapPersonOutcome =
  { ok: true; task: Task } | { ok: false; status: 404 | 409; body: Record<string, unknown> };

/** Where the acts read and write. */
type PersonStore = Pick<TaskStore, 'getTask' | 'approvals' | 'updateTask'>;

const NOT_FOUND = { ok: false, status: 404, body: { error: 'Scheduled task not found' } } as const;

/** What a person reads when the file or the cap moved on since what they acted on. */
function changedSince(task: Task, message: string): FileCapPersonOutcome {
  return {
    ok: false,
    status: 409,
    body: { error: 'Nothing to change', code: 'file_changed_since', message, taskId: task.id },
  };
}

/** The audit row for a person's act on a cap. */
function auditPerson(task: Task, before: string | undefined, after: string, act: string): void {
  recordAudit({
    action: FILE_CAP_ACTION,
    operation: 'modify',
    target: { type: 'task', id: task.id, name: task.displayName ?? task.name },
    outcome: 'ok',
    change: [{ field: 'attestedFileHash', before: before ?? null, after }],
    summary: `${act}: ${task.displayName ?? task.name}`,
  });
}

/**
 * Undo an agent's cap lift: the attestation it replaced comes back, so the
 * task's next run is capped again.
 *
 * @param store - The store.
 * @param id - The schedule.
 * @param liftAt - When the lift the notice named was made.
 */
export function undoFileCapLift(
  store: PersonStore,
  id: string,
  liftAt: string
): FileCapPersonOutcome {
  const task = store.getTask(id);
  if (!task) return NOT_FOUND;
  const { fileLift, fileAttest } = store.approvals.agentModeColumnOf(id);
  if (fileLift?.at !== liftAt || fileAttest?.hash !== fileLift.hash) {
    return changedSince(task, 'Not undone: this task changed since this notice.');
  }
  store.approvals.patchAgentModeColumn(id, { fileAttest: fileLift.previous, fileLift: null });
  auditPerson(task, fileAttest.hash, fileLift.previous.hash, 'Capped again by a person');
  return { ok: true, task: store.getTask(id) ?? task };
}

/**
 * Approve the task's SKILL file as the person's diff showed it, lifting its
 * cap: only the cap the person saw (`capAt`), only the hash that diff showed
 * (`hash`), and only while the file still hashes to it. The row is set to that
 * body too, so the run sends what was approved (M-D).
 *
 * @param store - The store.
 * @param id - The schedule.
 * @param capAt - When the cap the person saw first held (`Task.fileCap.at`).
 * @param hash - The file hash the diff showed (`Task.fileCap.hash`).
 */
export async function approveCappedFile(
  store: PersonStore,
  id: string,
  capAt: string,
  hash: string
): Promise<FileCapPersonOutcome> {
  const task = store.getTask(id);
  if (!task) return NOT_FOUND;
  const { fileCap, fileAttest } = store.approvals.agentModeColumnOf(id);
  const state = await readFileState(task.filePath);
  if (fileCap?.at !== capAt || fileCap.to !== hash || !state || state.hash !== hash) {
    return changedSince(task, 'The file changed again. Its next run shows the change.');
  }
  store.approvals.patchAgentModeColumn(id, {
    fileAttest: attestationOf(state, 'person'),
    fileCap: null,
    fileLift: null,
  });
  if (task.prompt !== state.body) store.updateTask(id, { prompt: state.body });
  auditPerson(task, fileAttest?.hash, state.hash, 'Approved a changed file');
  return { ok: true, task: store.getTask(id) ?? task };
}
