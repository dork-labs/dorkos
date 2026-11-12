/**
 * After an agent's write lands: who changed the schedule, what an agent
 * approved, the audit row and the Activity line (DOR-3703, Security rulings 5,
 * 7 and 8), and the park that follows when a later edit no longer matches what
 * an agent approved.
 *
 * @module services/tasks/agent-mode/agent-mode-record
 */
import type { MeshCore } from '@dorkos/mesh';
import type { Task, UpdateTaskRequest } from '@dorkos/shared/types';
import type { ActivityService } from '../../activity/activity-service.js';
import { recordAudit } from '../../audit/audit-trail.js';
import { resolveStanding } from '../../notifications/notification-service.js';
import { raiseStanding } from '../../notifications/standing-events.js';
import { resolveScheduleParkPayload } from '../../notifications/emitters/schedule-park.js';
import { logError, logger } from '../../../lib/logger.js';
import type { TaskStore } from '../task-store.js';
import { agentApprovalBindingOf } from './agent-mode-binding.js';
import {
  AGENT_MODE_ACTION_TITLES,
  agentModeControlOn,
  MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS,
} from './agent-mode-actions.js';
import { agentModeSnapshotOf, type AgentModeGrant } from './agent-mode-door.js';
import { agentModeRecordText } from './agent-mode-record-field.js';
import { agentIdOfHome } from '../approvals/schedule-owner.js';
import { liveAgentModeSources } from './agent-mode-sources.js';
import { modeNeedsAPerson, type AgentModeSources } from './agent-mode-decision.js';
import { isRaise } from './agent-mode-attest.js';
import {
  clampModeToCeiling,
  levelOfMode,
  resolveCeilingLevel,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import { changesApprovedWork } from '../task-file-update.js';
import {
  fileChangedWhileSwitchedOff,
  fileEditsRunCapped,
  runsCappedForFile,
} from './file-cap/file-cap-rule.js';
import { attestPersonEdit } from './file-cap/file-cap-person.js';

/** Mesh as recording reads it: the folder a task runs in, and the agent a home is. */
type RecordMesh =
  (Pick<MeshCore, 'getProjectPath'> & Partial<Pick<MeshCore, 'listWithPaths'>>) | undefined;

/** The folder a task's runs start in: its agent's, or none. */
function runFolderOf(task: Task, meshCore: Pick<MeshCore, 'getProjectPath'> | undefined) {
  return task.agentId ? (meshCore?.getProjectPath(task.agentId) ?? null) : null;
}

/** Where the Activity line and the task's own row point: the task in the Tasks list. */
function taskLinkOf(task: Pick<Task, 'name'>): string {
  return `/tasks?search=${encodeURIComponent(task.name)}`;
}

/**
 * The audit row for an agent's mode or approval (Security ruling 8, C3): who,
 * how it reached DorkOS and how its identity was resolved, old → new mode, the
 * task hash, and whether a card or a setting let it through. Written BEFORE the
 * change it records; returns whether the row was stored, and a caller writes
 * nothing when it was not.
 *
 * @param grant - The settled grant.
 * @param before - The task before, `null` on a create.
 * @param after - The task as it will be.
 * @param binding - Its hash as it will be.
 * @param meshCore - Mesh, to name the setter's agent.
 */
export function auditAgentMode(
  grant: AgentModeGrant,
  before: Task | null,
  after: Task,
  binding: string,
  meshCore: RecordMesh
) {
  const { decision } = grant;
  const setterId =
    grant.setterPath && meshCore?.listWithPaths
      ? (agentIdOfHome(meshCore as Pick<MeshCore, 'listWithPaths'>, grant.setterPath) ?? null)
      : null;
  const label = after.displayName ?? after.name;
  const event = recordAudit({
    action: decision.primary,
    operation: 'modify',
    target: { type: 'task', id: after.id, name: label },
    outcome: 'ok',
    change: [
      {
        field: 'permissionMode',
        before: before?.permissionMode ?? null,
        after: after.permissionMode,
      },
      ...(decision.approves ? [{ field: 'status', before: before?.status, after: 'active' }] : []),
      { field: 'reachedVia', after: grant.credential },
      { field: 'setterAgentId', after: setterId },
      { field: 'identityResolvedVia', after: grant.resolved },
      { field: 'decidedBy', after: grant.via },
      ...(grant.startedBy ? [{ field: 'turnStartedBy', after: grant.startedBy }] : []),
      { field: 'taskHash', after: binding },
    ],
    ...(grant.approvalId ? { links: { approvalId: grant.approvalId } } : {}),
    summary: `${AGENT_MODE_ACTION_TITLES[decision.primary]}: ${label}, ${after.permissionMode}`,
  });
  return event !== undefined;
}

/** What the task's own row records about this grant. */
function recordTextOf(grant: AgentModeGrant, before: Task | null, after: Task, agentPath?: string) {
  return agentModeRecordText({
    kind: grant.decision.approves ? 'approved' : 'set_mode',
    agentPath: agentPath ?? '',
    at: new Date().toISOString(),
    mode: after.permissionMode,
    previousMode: before?.permissionMode ?? null,
  });
}

/**
 * Arm a schedule an agent approved, or arm nothing (Security rulings 7 and 8).
 * Synchronous from first read to last write, so no other call can land in
 * between: the task must still be exactly what the decision read
 * ({@link agentModeSnapshotOf}), the audit row must be stored, and then the
 * status, the content grant, the binding and the task's own record are written
 * in one transaction. Any of those failing arms nothing and answers `null`.
 *
 * @param ctx - The grant, the task as the decision read it, and where to write.
 */
export function armAgentApproval(ctx: {
  grant: AgentModeGrant;
  before: Task;
  store: Pick<TaskStore, 'approvals' | 'getTask' | 'updateTask'>;
  meshCore: RecordMesh;
  agentPath?: string;
}): Task | null {
  // The mode an approval names is written here, with the status, or not at all (S-C).
  const setMode = ctx.grant.decision.setsMode ? ctx.grant.decision.mode : undefined;
  const { grant, before, store } = ctx;
  const stillSo = () => {
    const now = store.getTask(before.id);
    const edits = store.approvals.agentEditsOf(before.id);
    return now && agentModeSnapshotOf(now, edits, grant.decision) === grant.snapshot ? now : null;
  };
  try {
    const found = stillSo();
    if (!found) return null;
    const now = setMode ? { ...found, permissionMode: setMode } : found;
    const binding = agentApprovalBindingOf(now, runFolderOf(now, ctx.meshCore));
    if (!auditAgentMode(grant, before, now, binding, ctx.meshCore)) return null;
    return store.approvals.inTransaction(() => {
      if (!stillSo()) throw new Error('the task changed while it was being approved');
      store.updateTask(now.id, {
        status: 'active',
        ...(setMode ? { permissionMode: setMode } : {}),
      });
      // A person's yes on the card approves the content it showed, and only that (M-A, M1).
      if (grant.via === 'card') store.approvals.recordPersonApproval(now.id, grant.boundContentKey);
      store.approvals.recordAgentApproval(
        now.id,
        binding,
        recordTextOf(grant, before, now, ctx.agentPath)
      );
      return store.getTask(now.id);
    });
  } catch (err) {
    logger.warn('[tasks] an agent approval was not armed', logError(err));
    return null;
  }
}

/**
 * After a granted mode or approval landed: the audit row and the task's own
 * record for a mode change (an approval wrote both in {@link armAgentApproval}),
 * one Activity line pointing at the task, and the end of the park's standing
 * condition. Never fails the write it follows.
 *
 * @param ctx - The grant, the task before and after, and where to record.
 */
export async function recordAgentModeOutcome(ctx: {
  grant: AgentModeGrant;
  before: Task | null;
  after: Task;
  store: Pick<TaskStore, 'approvals'>;
  meshCore: RecordMesh;
  activity?: Pick<ActivityService, 'emit'>;
  agentPath?: string;
}): Promise<void> {
  try {
    const { grant, before, after } = ctx;
    const { decision } = grant;
    const binding = agentApprovalBindingOf(after, runFolderOf(after, ctx.meshCore));
    if (!decision.approves) {
      ctx.store.approvals.recordAgentModeChange(
        after.id,
        recordTextOf(grant, before, after, ctx.agentPath)
      );
    }
    const label = after.displayName ?? after.name;
    ctx.activity?.emit({
      actorType: 'agent',
      actorLabel: 'An agent',
      ...(ctx.agentPath ? { actorId: ctx.agentPath } : {}),
      category: 'tasks',
      eventType: decision.approves ? 'tasks.task_approved' : 'tasks.task_mode_changed',
      resourceType: 'schedule',
      resourceId: after.id,
      resourceLabel: label,
      summary: decision.approves
        ? `Approved scheduled task ${label}, running as ${after.permissionMode}`
        : `Set scheduled task ${label} to run as ${after.permissionMode}`,
      metadata: {
        permissionMode: after.permissionMode,
        previousPermissionMode: before?.permissionMode ?? null,
        decidedBy: grant.via,
        reachedVia: grant.credential,
        taskHash: binding,
      },
      linkPath: taskLinkOf(after),
    });
    if (decision.approves) {
      const payload = await resolveScheduleParkPayload(after);
      void resolveStanding('schedule.parked', payload, {
        outcome: 'approved',
        actorPrincipal: { kind: 'agent' },
      });
    }
  } catch (err) {
    logger.warn('[tasks] could not record an agent mode change', logError(err));
  }
}

/**
 * Whether a mode an agent set may RUN now (M-A, and the Security ruling of
 * Nov 3). A person's yes on this call's card runs what it showed: a mode up to
 * Don't ask, or a looser one while the person approved the content as it is
 * now. Without a card, a scheduled run's raise waits for a person (condition
 * 3); a mode up to Don't ask runs; a looser one runs, while
 * {@link MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS} holds, on content a
 * person approved or when the task's own agent vouches for the write
 * (`agent-mode-attest.ts`).
 *
 * @param grant - The settled grant.
 * @param personApprovedCurrent - Whether a person approved the content as it is now.
 */
export function grantedModeMayRun(grant: AgentModeGrant, personApprovedCurrent: boolean): boolean {
  const { decision } = grant;
  if (grant.via === 'card') return !decision.aboveDontAsk || personApprovedCurrent;
  if (decision.scheduledRaise) return false;
  if (!decision.aboveDontAsk) return true;
  return (
    MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS && (personApprovedCurrent || decision.vouched)
  );
}

/**
 * Whether an agent's edit may keep this schedule live instead of parking it
 * for a person, by the new rules (Security ruling 7, the Nov 2 answer and the
 * Nov 3 ruling): not once an agent approved it; at a mode looser than Don't
 * ask only when the task's own agent vouches for the edit
 * (`agent-mode-attest.ts`). With the experiment off, nothing changes.
 *
 * @param task - The schedule before the edit.
 * @param store - Where its agent approval is kept.
 * @param vouched - Whether the task's own agent vouches for this edit.
 * @param sources - Override for tests.
 */
export function agentEditMayStayLive(
  task: Task,
  store: Pick<TaskStore, 'approvals'>,
  vouched = false,
  sources: Pick<AgentModeSources, 'declaredModes'> = liveAgentModeSources(undefined)
): boolean {
  if (!agentModeControlOn()) return true;
  if (store.approvals.agentEditsOf(task.id)?.agentApprovalKey) return false;
  if (vouched) return true;
  const declared = sources.declaredModes(task.runtime);
  // A runtime that declares no modes cannot say how loose this one is, so it parks.
  return declared !== undefined && !modeNeedsAPerson(declared, task.permissionMode);
}

/**
 * Park an agent-approved schedule again when an agent's later edit changed
 * what was approved (Security ruling 7): an approval never covers a later
 * version. Returns whether it parked.
 *
 * @param task - The schedule after the edit.
 * @param store - The store.
 * @param meshCore - Mesh, for the folder its runs start in.
 */
export function reparkIfAgentApprovalBroken(
  task: Task,
  store: Pick<TaskStore, 'approvals' | 'updateTask'>,
  meshCore: Pick<MeshCore, 'getProjectPath'> | undefined
): boolean {
  const key = store.approvals.agentEditsOf(task.id)?.agentApprovalKey;
  if (!key || task.status !== 'active') return false;
  if (agentApprovalBindingOf(task, runFolderOf(task, meshCore)) === key) return false;
  store.updateTask(task.id, { status: 'pending_approval' });
  return true;
}

/** What the dispatch check reads beyond the store. */
type DispatchSources = Pick<AgentModeSources, 'declaredModes' | 'agentLevelMode' | 'agentPathOf'>;

/**
 * Whether a schedule an agent wrote may run above Don't ask now, checked again
 * when it would run (M-A, round 3 S4, and the Nov 3 ruling): the mode is still
 * within the level a person set for its agent (a person who lowered the agent
 * since parks its tasks, condition 2), and a person approved the content as it
 * is, or the task's own agent vouched for it at a mode at least this loose.
 * The attestation carries the content key it vouched for, so a check of the
 * task's file against it slots in beside these two.
 *
 * @param task - The schedule, read fresh.
 * @param store - The store.
 * @param declared - Its runtime's modes.
 * @param sources - Where the agent's level is read.
 */
async function agentModeStillHolds(
  task: Task,
  store: Pick<TaskStore, 'approvals'>,
  declared: DeclaredModes,
  sources: DispatchSources
): Promise<boolean> {
  const owner = task.agentId ? sources.agentPathOf(task.agentId) : task.proposedByAgentPath;
  if (!owner) return false;
  const agentMode = await sources.agentLevelMode(owner, task.runtime);
  const level =
    levelOfMode(declared, agentMode) ?? resolveCeilingLevel(declared, 'runtime-default');
  if (clampModeToCeiling(declared, task.permissionMode, level) !== task.permissionMode) {
    return false;
  }
  if (store.approvals.personApprovedCurrent(task.id)) return true;
  // A run its changed SKILL file caps at Don't ask needs nobody for its mode (M4).
  if (await runsCappedForFile(task, store)) return true;
  const attestation = store.approvals.agentEditsOf(task.id)?.attestation;
  return !!attestation && !isRaise(declared, task.permissionMode, attestation.mode);
}

/**
 * Park a schedule an agent wrote whose mode above Don't ask no longer holds
 * ({@link agentModeStillHolds}). Only a schedule an agent set the mode of, or
 * vouched for, is held to this: a row nothing has written since the upgrade
 * keeps running as it was (M5), and a person's own mode is theirs. Returns
 * whether it parked.
 *
 * @param task - The schedule, read fresh.
 * @param store - The store.
 * @param sources - Where the runtime's modes and the agent's level are read.
 */
async function parkIfAgentModeUnvouched(
  task: Task,
  store: Pick<TaskStore, 'approvals' | 'updateTask'>,
  sources: DispatchSources
): Promise<boolean> {
  if (!agentModeControlOn() || task.status !== 'active') return false;
  const agentSet = task.agentModeRecord?.mode === task.permissionMode;
  if (!agentSet && !store.approvals.agentEditsOf(task.id)?.attestation) return false;
  const declared = sources.declaredModes(task.runtime);
  // A runtime that declares no modes cannot run the task at all, so it is not parked here.
  if (!declared || !modeNeedsAPerson(declared, task.permissionMode)) return false;
  if (await agentModeStillHolds(task, store, declared, sources)) return false;
  store.updateTask(task.id, { status: 'pending_approval' });
  return true;
}

/**
 * With the switch off, park a task whose file changed from what was attested
 * while it was on (SB1, `fileChangedWhileSwitchedOff`). Returns whether it parked.
 *
 * @param task - The schedule, read fresh.
 * @param store - The store.
 */
async function parkIfFileChangedSwitchedOff(
  task: Task,
  store: Pick<TaskStore, 'approvals' | 'updateTask'>
): Promise<boolean> {
  if (task.status !== 'active' || !(await fileChangedWhileSwitchedOff(task, store))) return false;
  store.updateTask(task.id, { status: 'pending_approval' });
  return true;
}

/**
 * Before a scheduled run starts (Security ruling 7, S6, round 3 S4, the Nov 3
 * ruling): an agent-approved schedule whose task no longer hashes to what was
 * approved, its SKILL file changed on disk or its agent's folder moved
 * included, and a schedule an agent wrote whose mode above Don't ask no longer
 * holds, is parked instead of run. Read fresh from the store; answers whether
 * it parked.
 *
 * @param taskId - The schedule about to fire.
 * @param store - The store.
 * @param meshCore - Mesh, for the folder its runs start in.
 * @param sources - Override for tests.
 */
export async function parkIfAgentApprovalStale(
  taskId: string,
  store: Pick<TaskStore, 'approvals' | 'updateTask' | 'getTask'>,
  meshCore: Pick<MeshCore, 'getProjectPath'> | null | undefined,
  sources: DispatchSources = liveAgentModeSources(meshCore ?? undefined)
): Promise<boolean> {
  const task = store.getTask(taskId);
  if (!task) return false;
  const parks =
    reparkIfAgentApprovalBroken(task, store, meshCore ?? undefined) ||
    (await parkIfAgentModeUnvouched(task, store, sources)) ||
    (await parkIfFileChangedSwitchedOff(task, store));
  if (!parks) return false;
  const parked = store.getTask(taskId) ?? task;
  void resolveScheduleParkPayload(parked).then((payload) =>
    raiseStanding('schedule.parked', payload)
  );
  return true;
}

/**
 * Whether a person's own edit approves the task's content (M-A, round 3 S3):
 * they armed it, set its mode, or changed what it does themselves, and it is
 * running. Switching it on or off, or renaming its description, approves
 * nothing they did not look at.
 *
 * @param existing - The task before the edit.
 * @param data - What the person sent.
 * @param updated - The task after it.
 */
function personEditApproves(existing: Task, data: UpdateTaskRequest, updated: Task): boolean {
  if (updated.status !== 'active') return false;
  const armed = existing.status === 'pending_approval';
  return armed || data.permissionMode !== undefined || changesApprovedWork(data, existing);
}

/**
 * A person set a schedule's mode (M2): it is theirs now, so the agent's record
 * of setting it goes; lowering it holds the task there against an agent's
 * raise, and raising it lifts that.
 *
 * @param store - The store.
 * @param existing - The task before the edit.
 * @param updated - The task after it.
 * @param sources - Where the runtime's modes are read.
 */
function settlePersonMode(
  store: Pick<TaskStore, 'approvals'>,
  existing: Task,
  updated: Task,
  sources: Pick<AgentModeSources, 'declaredModes'>
): void {
  if (updated.permissionMode === existing.permissionMode) return;
  store.approvals.recordAgentModeChange(updated.id, null);
  const declared = sources.declaredModes(updated.runtime);
  if (!declared) return;
  if (isRaise(declared, existing.permissionMode, updated.permissionMode)) {
    store.approvals.setPersonFloor(updated.id, updated.permissionMode);
  } else if (isRaise(declared, updated.permissionMode, existing.permissionMode)) {
    store.approvals.setPersonFloor(updated.id, null);
  }
}

/**
 * After `PATCH /api/tasks/:id` wrote: a person's edit that armed the task, set
 * its mode or changed its content is their approval of that content (M-A, S3),
 * and a prompt they wrote, or the one their approval card showed them, approves
 * the SKILL file holding exactly it (M4, M-C); a row door that showed nothing
 * attests nothing;
 * an agent's is recorded as the last edit, and parks a task that no longer
 * matches what an agent approved. Returns the task as it now stands.
 *
 * @param store - The store.
 * @param meshCore - Mesh, for the folder its runs start in.
 * @param trusted - Whether the caller cleared the person bar.
 * @param agentIdentity - The calling agent, when a token named one.
 * @param edit - The task before, what was sent, and the task after.
 */
export async function settleHttpTaskEdit(
  store: Pick<TaskStore, 'approvals' | 'updateTask' | 'getTask'>,
  meshCore: Pick<MeshCore, 'getProjectPath'> | undefined,
  trusted: boolean,
  agentIdentity: { agentPath: string; inactive?: unknown } | undefined,
  edit: { existing: Task; data: UpdateTaskRequest; updated: Task }
): Promise<Task> {
  const { updated } = edit;
  if (trusted) {
    if (personEditApproves(edit.existing, edit.data, updated)) {
      store.approvals.recordPersonApproval(updated.id);
    }
    // Only a prompt the person wrote, or the one their approval card showed them,
    // approves the file, and only those bytes (M4, M-C, round 8 ruling).
    if (fileEditsRunCapped(updated)) await attestPersonEdit(store, updated, edit.data);
    settlePersonMode(store, edit.existing, updated, liveAgentModeSources(meshCore));
    return updated;
  }
  const agentPath = agentIdentity && !agentIdentity.inactive ? agentIdentity.agentPath : null;
  store.approvals.recordAgentEdit(updated.id, { agentPath, sessionId: null });
  if (!reparkIfAgentApprovalBroken(updated, store, meshCore)) return updated;
  return store.getTask(updated.id) ?? updated;
}
