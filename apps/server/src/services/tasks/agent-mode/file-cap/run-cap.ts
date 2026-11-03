/**
 * The cap at dispatch (DOR-3703, M4): a run whose SKILL file no longer hashes
 * to its attested hash still happens, at Don't ask, and its prompt says why.
 * It is never parked here.
 *
 * - The FILE and the prompt the run sends are both compared with the attested
 *   hash (M8, M-D): a prompt the sync folded in runs under the cap, and so does
 *   a file put back while the row still holds the change.
 * - A row with no attested hash yet records the file as its baseline and runs
 *   as it always did, but only while the row's prompt is the file and no sync
 *   folded it in (M5, M-B).
 * - The run is marked capped, so its history never reads as a plain success.
 * - The person is told once per pair of hashes: a notable notice, never a
 *   "Needs you" row and no card. The audit row keeps both hashes.
 *
 * @module services/tasks/agent-mode/file-cap/run-cap
 */
import type { MeshCore } from '@dorkos/mesh';
import type { PermissionMode, Task, TaskRun } from '@dorkos/shared/types';
import {
  clampModeToCeiling,
  levelOfMode,
  READ_ONLY_LEVEL,
} from '@dorkos/shared/permission-semantics';
import type { TaskStore } from '../../task-store.js';
import { recordAudit } from '../../../audit/audit-trail.js';
import {
  postScheduleArmed,
  resolveScheduleArmedPayload,
} from '../../../notifications/emitters/schedule-armed.js';
import { logError, logger } from '../../../../lib/logger.js';
import { AGENT_MODE_WITHOUT_A_PERSON } from '../agent-mode-actions.js';
import { modeNeedsAPerson } from '../agent-mode-decision.js';
import { liveAgentModeSources } from '../agent-mode-sources.js';
import type { AgentModeColumn, FileCapState } from '../agent-mode-record-field.js';
import { attestationOf, fileEditsRunCapped } from './file-cap-rule.js';
import {
  bodyHash,
  KEPT_BODY_CHARS,
  readFileState,
  shortFileHash,
  type FileState,
} from './file-hash.js';
import { liveOrdinaryTurns, type OrdinaryTurnsSource } from './ordinary-turns.js';
import { CAPPED_RUN_PREAMBLE } from './file-cap-copy.js';

/** The audit action a cap is recorded under. */
export const FILE_CAP_ACTION = 'tasks.file_cap';

/** Where the cap reads and writes. */
export type RunCapStore = Pick<TaskStore, 'approvals' | 'updateRun' | 'resolveTaskOrigins'>;

/**
 * The mode a capped run gets: the task's own when it is already no looser
 * than Don't ask, Don't ask otherwise (or the runtime's nearest mode to it).
 *
 * @param task - The task as it would run.
 */
export function cappedModeOf(task: Pick<Task, 'permissionMode' | 'runtime'>): PermissionMode {
  const declared = liveAgentModeSources(undefined).declaredModes(task.runtime);
  if (!declared) return AGENT_MODE_WITHOUT_A_PERSON;
  if (!modeNeedsAPerson(declared, task.permissionMode)) return task.permissionMode;
  if (declared.values.some((m) => m.id === AGENT_MODE_WITHOUT_A_PERSON)) {
    return AGENT_MODE_WITHOUT_A_PERSON;
  }
  const cap = levelOfMode(declared, AGENT_MODE_WITHOUT_A_PERSON) ?? READ_ONLY_LEVEL;
  return clampModeToCeiling(declared, task.permissionMode, cap) as PermissionMode;
}

/**
 * The capped mode's name as the task's runtime names it in its mode picker,
 * so the notice and the task's own row say the same word.
 *
 * @param task - The task as it would run.
 */
export function cappedLabelOf(task: Pick<Task, 'permissionMode' | 'runtime'>): string {
  const mode = cappedModeOf(task);
  const declared = liveAgentModeSources(undefined).declaredModes(task.runtime);
  return declared?.values.find((m) => m.id === mode)?.label ?? mode;
}

/** Record the cap the first time it holds for this pair of hashes, and tell the person. */
async function recordNewCap(task: Task, cap: FileCapState): Promise<void> {
  const label = task.displayName ?? task.name;
  recordAudit({
    action: FILE_CAP_ACTION,
    operation: 'modify',
    target: { type: 'task', id: task.id, name: label },
    outcome: 'ok',
    change: [
      { field: 'permissionMode', before: task.permissionMode, after: cappedModeOf(task) },
      { field: 'attestedFileHash', after: cap.from },
      { field: 'fileHash', after: cap.to },
    ],
    summary: `Capped ${label} at ${cappedLabelOf(task)}: its file changed outside the task tools`,
  });
  // No notice for a file that cannot be read: the sync tells the person about that.
  if (cap.to === null) return;
  try {
    const payload = await resolveScheduleArmedPayload(task);
    await postScheduleArmed({
      ...payload,
      fileChange: {
        kind: 'capped',
        fromHash: shortFileHash(cap.from),
        toHash: shortFileHash(cap.to),
        at: cap.at,
        cappedAs: cappedLabelOf(task),
      },
    });
  } catch (err) {
    logger.warn('[tasks] could not post the notice for a capped file', logError(err));
  }
}

/** What a run resolved to run on, as much as the cap reads. */
export interface RunCapExecution {
  /** The runtime the run resolved to, whose modes the cap names. */
  runtimeType: string;
}

/**
 * Whether the run may go uncapped: the file AND the prompt the run sends both
 * hash to the attested hash (M-D). A row with no attested hash yet takes the
 * file as its baseline only when the prompt it runs is the file and no sync
 * folded that prompt in (M5, M-B).
 */
function runsUncapped(
  task: Task,
  column: AgentModeColumn,
  state: FileState | null,
  store: RunCapStore
): boolean {
  const runs = bodyHash(task.prompt);
  if (column.fileAttest)
    return state?.hash === column.fileAttest.hash && runs === column.fileAttest.hash;
  if (!state || state.hash !== runs || column.syncedPrompt === state.hash) return false;
  store.approvals.patchAgentModeColumn(task.id, { fileAttest: attestationOf(state, 'baseline') });
  return true;
}

/**
 * The task as this run should run it: unchanged, or capped at Never ask (the
 * mode its resolved runtime declares) on a fresh chat, with its prompt saying
 * why. A warm sticky chat keeps the mode it was launched at, so a capped run
 * never resumes one (M-E). Throws when its records cannot be read or written;
 * the caller fails the run then.
 *
 * @param task - The task, read fresh, as it would run.
 * @param run - Its run row, already opened.
 * @param store - The store.
 * @param meshCore - Mesh, for the agent's home.
 * @param execution - What the run resolved to run on; the task's own runtime when absent.
 * @param ordinaryTurns - Whether the agent had an ordinary turn lately; the
 *   live session history by default.
 */
export async function capRunIfFileChanged(
  task: Task,
  run: Pick<TaskRun, 'id'>,
  store: RunCapStore,
  meshCore?: Pick<MeshCore, 'getProjectPath'> | null,
  execution?: RunCapExecution,
  ordinaryTurns: OrdinaryTurnsSource = liveOrdinaryTurns(store)
): Promise<Task> {
  if (!fileEditsRunCapped(task)) return task;
  const { approvals } = store;
  const column = approvals.agentModeColumnOf(task.id);
  const state = await readFileState(task.filePath);
  if (runsUncapped(task, column, state, store)) {
    // Back to what was attested: no cap to show.
    if (column.fileCap) approvals.patchAgentModeColumn(task.id, { fileCap: null });
    return task;
  }
  const resolved = { ...task, runtime: execution?.runtimeType ?? task.runtime };
  const from = column.fileAttest?.hash ?? 'none';
  const to = state?.hash ?? null;
  const agentPath = task.agentId ? (meshCore?.getProjectPath(task.agentId) ?? null) : null;
  const needsPerson =
    agentPath && task.agentId ? !(await ordinaryTurns(agentPath, task.agentId)) : true;
  const same = column.fileCap?.from === from && column.fileCap.to === to;
  const kept = state && state.body.length <= KEPT_BODY_CHARS ? { current: state.body } : {};
  const cap: FileCapState = same
    ? { ...column.fileCap!, needsPerson }
    : { from, to, at: new Date().toISOString(), needsPerson, ...kept };
  approvals.patchAgentModeColumn(task.id, { fileCap: cap });
  if (!same) await recordNewCap(resolved, cap);
  store.updateRun(run.id, { cappedAt: 'dontAsk' });
  return {
    ...task,
    permissionMode: cappedModeOf(resolved),
    // A fresh chat: a sticky one already launched keeps its own mode.
    sticky: false,
    prompt: `${CAPPED_RUN_PREAMBLE}\n\n${task.prompt}`,
  };
}
