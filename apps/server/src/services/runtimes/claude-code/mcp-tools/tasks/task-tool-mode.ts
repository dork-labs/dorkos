/**
 * The `tasks_*` tools' side of an agent's mode or approval (DOR-3703): decide
 * the call before the write, and record after it. Split from `task-tools.ts`
 * so the handlers read as one sequence each; the rules live in
 * `services/tasks/agent-mode/`.
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/task-tool-mode
 */
import type { Task } from '@dorkos/shared/types';
import type { McpToolDeps } from '../types.js';
import { agentModeControlOn } from '../../../../tasks/agent-mode/agent-mode-actions.js';
import {
  settleAgentModeCall,
  type AgentModeDoorCall,
  type AgentModeSettlement,
} from '../../../../tasks/agent-mode/agent-mode-door.js';
import {
  armAgentApproval,
  auditAgentMode,
  grantedModeMayRun,
  recordAgentModeOutcome,
  reparkIfAgentApprovalBroken,
} from '../../../../tasks/agent-mode/agent-mode-record.js';
import { agentApprovalBindingOf } from '../../../../tasks/agent-mode/agent-mode-binding.js';
import {
  announceAgentModeChange,
  announceAgentPromptChange,
} from '../../../../tasks/agent-mode/agent-mode-notice.js';
import {
  modeNeedsAPerson,
  type AgentModeCaller,
} from '../../../../tasks/agent-mode/agent-mode-decision.js';
import { liveAgentModeSources } from '../../../../tasks/agent-mode/agent-mode-sources.js';
import { applyTaskFileUpdate } from '../../../../tasks/lifecycle/update-task-file.js';
import { revertUntoldAgentMode } from '../../../../tasks/agent-mode/agent-mode-undo.js';
import {
  liveRunOriginSources,
  turnStarterOf,
} from '../../../../tasks/agent-mode/agent-mode-run-origin.js';
import { broadcastTasksChanged } from '../../../../tasks/task-sse-events.js';
import { scheduleContentKey, taskWorkOf } from '../../../../tasks/schedule-permission-clamp.js';
import { ownAgentVouches } from '../../../../tasks/agent-mode/agent-mode-attest.js';
import {
  clampModeToCeiling,
  levelOfMode,
  resolveCeilingLevel,
} from '@dorkos/shared/permission-semantics';
import { logger } from '../../../../../lib/logger.js';
import {
  AGENT_MODE_REFUSAL_ERROR,
  CONTENT_CHANGED_MESSAGE,
} from '../../../../tasks/agent-mode/agent-mode-copy.js';

/**
 * Decide a write's mode or approval, or nothing at all while the experiment is
 * off (the tools then refuse both fields as they always have).
 *
 * @param deps - The tool dependencies.
 * @param call - The write, without the editor record, which is read here.
 */
export async function settleToolModeCall(
  deps: McpToolDeps,
  call: Omit<AgentModeDoorCall, 'edits'>
): Promise<AgentModeSettlement> {
  if (!agentModeControlOn()) return {};
  const edits = call.task ? deps.taskStore!.approvals.agentEditsOf(call.task.id) : undefined;
  const settled = await settleAgentModeCall(
    { ...call, ...(edits !== undefined ? { edits } : {}) },
    deps.meshCore
  );
  // Who started the turn, for the notice and the audit row (M6).
  if (settled.grant) {
    settled.grant.startedBy = turnStarterOf(call.caller, liveRunOriginSources(deps.taskStore!));
  }
  return settled;
}

/**
 * Record a granted mode or approval once the write landed: audit row, Activity
 * line and, for an approval, what it was bound to. A new task a person said yes
 * to on its card is approved as it was created; and a mode an agent set above
 * Don't ask with no card, on a task that keeps running, posts the person a
 * notice with Undo (final rulings, condition 4). Nothing when none was granted.
 *
 * Fail-closed on that notice: when it cannot be posted, the old mode is put
 * back (the Undo path, audited as reverted) and this answers `false`, so the
 * caller tells the agent nothing changed rather than reporting success.
 *
 * @param deps - The tool dependencies.
 * @param mode - The settlement the write went ahead on.
 * @param before - The task before the write, `null` on a create.
 * @param after - The task after it.
 * @param caller - Who made it.
 * @param vouched - Whether the task's own agent vouched for the write.
 * @returns Whether the change stands.
 */
export async function recordToolModeOutcome(
  deps: McpToolDeps,
  mode: AgentModeSettlement,
  before: Task | null,
  after: Task,
  caller: AgentModeCaller,
  vouched = false
): Promise<boolean> {
  const grant = mode.grant;
  if (!(await reportOwnPromptEdit(deps, before, after, caller, vouched))) return false;
  if (!grant) return true;
  await recordAgentModeOutcome({
    grant,
    before,
    after,
    store: deps.taskStore!,
    meshCore: deps.meshCore,
    ...(deps.activityService ? { activity: deps.activityService } : {}),
    ...(caller.agentPath ? { agentPath: caller.agentPath } : {}),
  });
  if (!before && grant.via === 'card' && after.status === 'active') {
    deps.taskStore!.approvals.recordPersonApproval(after.id, scheduleContentKey(taskWorkOf(after)));
  }
  // A new task its own agent vouches for: the content it wrote, attested (M1).
  if (!before && grant.via === 'allowed' && grant.decision.vouched && after.status === 'active') {
    recordToolAttestation(deps, after, caller, true, grant.startedBy ?? 'an agent');
  }
  // Every raise that lands without a card is told to the person (M6).
  const unasked = modeOnly(mode) && grant.via === 'allowed' && grant.decision.raise;
  if (!before || !unasked || after.status !== 'active') return true;
  // The notice names this change by its record's time, so its Undo acts on it alone (M9).
  const modeAt = deps.taskStore!.getTask(after.id)?.agentModeRecord?.at ?? new Date().toISOString();
  const told = await announceAgentModeChange(
    {
      after,
      previousMode: before.permissionMode,
      ...(caller.agentPath ? { setterPath: caller.agentPath } : {}),
      startedBy: grant.startedBy ?? 'an agent',
      at: modeAt,
    },
    liveAgentModeSources(deps.meshCore)
  );
  if (told) return true;
  await revertUntoldAgentMode(
    {
      store: deps.taskStore!,
      dorkHome: deps.dorkHome,
      ...(deps.meshCore ? { meshCore: deps.meshCore } : {}),
    },
    after,
    before.permissionMode,
    { modeAt }
  );
  broadcastTasksChanged();
  return false;
}

/**
 * The task's own agent rewrote a running schedule's prompt above Don't ask
 * (Nov 3 ruling, M6): keep the prompt it replaced for a person's Undo, and
 * tell the person. Fail-closed: when the notice cannot be posted, the old
 * prompt goes back and this answers `false`.
 *
 * @param deps - The tool dependencies.
 * @param before - The task before the write, `null` on a create.
 * @param after - The task after it.
 * @param caller - Who wrote it.
 * @param vouched - Whether the task's own agent vouched for the write.
 */
async function reportOwnPromptEdit(
  deps: McpToolDeps,
  before: Task | null,
  after: Task,
  caller: AgentModeCaller,
  vouched: boolean
): Promise<boolean> {
  if (!before || !vouched || caller.scheduledRun || before.prompt === after.prompt) return true;
  if (after.status !== 'active') return true;
  const declared = liveAgentModeSources(deps.meshCore).declaredModes(after.runtime);
  if (declared && !modeNeedsAPerson(declared, after.permissionMode)) return true;
  const store = deps.taskStore!;
  const at = new Date().toISOString();
  store.approvals.setPromptUndo(after.id, { previous: before.prompt, written: after.prompt, at });
  const told = await announceAgentPromptChange({
    after,
    previousPrompt: before.prompt,
    ...(caller.agentPath ? { setterPath: caller.agentPath } : {}),
    startedBy: turnStarterOf(caller, liveRunOriginSources(store)),
    at,
  });
  if (told) return true;
  await revertUntoldAgentMode(
    { store, dorkHome: deps.dorkHome, ...(deps.meshCore ? { meshCore: deps.meshCore } : {}) },
    after,
    after.permissionMode,
    { promptAt: at }
  );
  broadcastTasksChanged();
  return false;
}

/** What an agent reads when the person could not be told of its mode change, so it was undone. */
export const NOT_TOLD_REFUSAL = {
  error: AGENT_MODE_REFUSAL_ERROR,
  code: 'not_told',
  message:
    'DorkOS could not tell the person about this change, so it put the task back as it was. ' +
    'Nothing was changed. Try again in a moment, or tell the person.',
} as const;

/**
 * Audit a granted mode change BEFORE it is written (S-D): an update's mode, or
 * a new task's. `false` means the row could not be stored, and the caller then
 * writes nothing. An approval is audited when it is armed instead.
 *
 * @param deps - The tool dependencies.
 * @param mode - The settlement the write will go ahead on.
 * @param before - The task as it stands, `null` on a create.
 * @param created - A create's body, when there is no task yet.
 */
export function auditToolModeChange(
  deps: McpToolDeps,
  mode: AgentModeSettlement,
  before: Task | null,
  created?: Record<string, unknown>
): boolean {
  const grant = mode.grant;
  if (!grant?.decision.setsMode || grant.decision.approves) return true;
  const base = before ?? ({ id: '(new)', ...created, filePath: '' } as unknown as Task);
  const after = { ...base, permissionMode: grant.decision.mode };
  const cwd = after.agentId ? (deps.meshCore?.getProjectPath(after.agentId) ?? null) : null;
  return auditAgentMode(grant, before, after, agentApprovalBindingOf(after, cwd), deps.meshCore);
}

/**
 * The create options a granted mode adds: the mode lands as named, and a task
 * above Don't ask that no person approved waits for one (M-A).
 *
 * @param mode - The settlement the create goes ahead on.
 */
export function createModeOptions(mode: AgentModeSettlement): {
  modeGranted?: true;
  parkForPerson?: true;
} {
  if (!mode.grant) return {};
  return {
    modeGranted: true,
    // A person's yes on the card approved this new task as it showed it.
    ...(grantedModeMayRun(mode.grant, mode.grant.via === 'card')
      ? {}
      : { parkForPerson: true as const }),
  };
}

/** Why an agent's edit parked its task, said in the same tool reply (PM, round 4). */
export const PARKED_BECAUSE = {
  agentApproval:
    'Another agent approved this task as it was, so your change waits for a person to approve it again.',
  scheduledRaise:
    'A scheduled run raised how this task runs, so it waits for a person to approve the new mode.',
  unvouched:
    'This task now runs looser than Don’t ask. No person approved it as it is, and this call ' +
    'could not vouch for it (only the task’s own agent can, from its own chat, in a turn that ' +
    'read no outside words), so it waits for a person.',
} as const;

/**
 * Whether the task's own agent vouches for an edit that sets no mode
 * (`agent-mode-attest.ts`): the same-agent conditions, and the task's current
 * mode within the level a person set for the agent (condition 2).
 *
 * @param deps - The tool dependencies.
 * @param existing - The task before the edit.
 * @param caller - Who is editing, with whether a scheduled run started it.
 */
export async function contentEditVouched(
  deps: McpToolDeps,
  existing: Task,
  caller: AgentModeCaller
): Promise<boolean> {
  if (!agentModeControlOn()) return false;
  const sources = liveAgentModeSources(deps.meshCore);
  // A turn DorkOS recorded no level for began before a restart, so it cannot
  // say who started it either (`agent-mode-run-origin.ts`): it never vouches.
  const ids = [caller.sessionId, ...(caller.turnSessionIds ?? [])].filter((id) => !!id);
  if (!ids.some((id) => sources.turnLevelOf(id!) !== undefined)) return false;
  const owner = existing.agentId
    ? sources.agentPathOf(existing.agentId)
    : (existing.proposedByAgentPath ?? undefined);
  const vouches = ownAgentVouches({
    caller,
    owner,
    proposer: existing.proposedByAgentPath,
    outsiderContent: existing.originMarks?.outsider === true,
    raise: false,
  });
  const declared = sources.declaredModes(existing.runtime);
  if (!vouches || !owner || !declared) return false;
  const agentMode = await sources.agentLevelMode(owner, existing.runtime);
  const level =
    levelOfMode(declared, agentMode) ?? resolveCeilingLevel(declared, 'runtime-default');
  return clampModeToCeiling(declared, existing.permissionMode, level) === existing.permissionMode;
}

/**
 * Record the task's own agent vouching for what it just wrote (M1): never a
 * person's approval. A content write vouches for the content it wrote; a mode
 * change keeps whatever content was vouched for before, and none when nothing
 * was (M3).
 *
 * @param deps - The tool dependencies.
 * @param updated - The task after the write.
 * @param caller - Who wrote it.
 * @param writesContent - Whether the write changed the content.
 * @param startedBy - Who started the calling turn.
 */
export function recordToolAttestation(
  deps: McpToolDeps,
  updated: Task,
  caller: AgentModeCaller,
  writesContent: boolean,
  startedBy: string
): void {
  const store = deps.taskStore!;
  const before = store.approvals.agentEditsOf(updated.id)?.attestation;
  store.approvals.recordAgentAttestation(updated.id, {
    agentPath: caller.agentPath!,
    sessionId: caller.sessionId ?? null,
    startedBy,
    turnLevel: caller.sessionId
      ? (liveAgentModeSources(deps.meshCore).turnLevelOf(caller.sessionId) ?? null)
      : null,
    marked: false,
    contentHash: writesContent
      ? scheduleContentKey(taskWorkOf(updated))
      : (before?.contentHash ?? null),
    mode: updated.permissionMode,
    at: new Date().toISOString(),
  });
}

/**
 * After an agent's edit: record who changed the schedule (a pure approval is
 * not a change), park it again when it no longer matches what an agent
 * approved, park it when the mode it set may not run without a person (M-A,
 * the Nov 3 ruling), and record the task's own agent vouching for a write it
 * may stand on (M1). Answers why it parked, for the tool reply, or `null`.
 *
 * @param deps - The tool dependencies.
 * @param updated - The task after the edit.
 * @param mode - The settlement the edit went ahead on.
 * @param caller - Who made it.
 * @param edit - Whether the task's own agent vouches for an edit with no mode
 *   ({@link contentEditVouched}), and whether it changed the content.
 */
export function afterToolAgentEdit(
  deps: McpToolDeps,
  updated: Task,
  mode: AgentModeSettlement,
  caller: AgentModeCaller,
  edit: { vouched: boolean; writesContent: boolean }
): string | null {
  const store = deps.taskStore!;
  const grant = mode.grant;
  if (grant?.decision.approves) return null;
  store.approvals.recordAgentEdit(updated.id, {
    agentPath: caller.agentPath ?? null,
    sessionId: caller.sessionId ?? null,
  });
  if (reparkIfAgentApprovalBroken(updated, store, deps.meshCore)) {
    return PARKED_BECAUSE.agentApproval;
  }
  const startedBy = grant?.startedBy ?? turnStarterOf(caller, liveRunOriginSources(store));
  if (!grant?.decision.setsMode) {
    if (edit.vouched && edit.writesContent && store.getTask(updated.id)?.status === 'active') {
      recordToolAttestation(deps, updated, caller, true, startedBy);
    }
    return null;
  }
  // A person's yes on this call's card approves the content it showed, and only
  // while the task still holds exactly that (M1): an edit that landed while the
  // file was written is not recorded as theirs, so the mode below parks.
  if (grant.via === 'card') store.approvals.recordPersonApproval(updated.id, grant.boundContentKey);
  if (updated.status !== 'active') return null;
  if (grantedModeMayRun(grant, store.approvals.personApprovedCurrent(updated.id))) {
    if (grant.via === 'allowed' && grant.decision.vouched) {
      recordToolAttestation(deps, updated, caller, edit.writesContent, startedBy);
    }
    return null;
  }
  store.updateTask(updated.id, { status: 'pending_approval' });
  return grant.decision.scheduledRaise ? PARKED_BECAUSE.scheduledRaise : PARKED_BECAUSE.unvouched;
}

/** What an agent reads when its approval could not be armed whole. */
export const NOT_ARMED_REFUSAL = {
  error: AGENT_MODE_REFUSAL_ERROR,
  code: 'not_armed',
  message: CONTENT_CHANGED_MESSAGE,
} as const;

/**
 * Arm the approval a grant carries, or say there is none to arm: the armed
 * task, `null` when it could not be armed (the task changed, or its record
 * could not be written), or `undefined` when the call approves nothing.
 *
 * @param deps - The tool dependencies.
 * @param mode - The settlement the write went ahead on.
 * @param before - The task as the decision read it.
 * @param caller - Who approved it.
 */
export async function armToolApproval(
  deps: McpToolDeps,
  mode: AgentModeSettlement,
  before: Task,
  caller: AgentModeCaller
): Promise<Task | null | undefined> {
  const grant = mode.grant;
  if (!grant?.decision.approves) return undefined;
  const armed = armAgentApproval({
    grant,
    before,
    store: deps.taskStore!,
    meshCore: deps.meshCore,
    ...(caller.agentPath ? { agentPath: caller.agentPath } : {}),
  });
  // The file follows the row once it is armed. Should it fail, the next sync
  // reads the file's mode against the row's and can only lower or park it.
  if (armed && grant.decision.setsMode) {
    const written = await applyTaskFileUpdate(
      { dorkHome: deps.dorkHome, ...(deps.meshCore && { meshCore: deps.meshCore }) },
      { existing: before, data: { permissionMode: grant.decision.mode } }
    );
    if (!written.ok) {
      logger.warn('[tasks] an approval armed, its file did not follow', { error: written.error });
    }
  }
  return armed;
}

/** What an agent reads when its mode change could not be recorded, so was not made (S-D). */
export const NOT_RECORDED_REFUSAL = {
  error: AGENT_MODE_REFUSAL_ERROR,
  code: 'not_recorded',
  message:
    'DorkOS could not record this change in its audit log, so it did not make it. Nothing was ' +
    'changed. Try again in a moment, or tell the person.',
} as const;

/**
 * Whether a grant sets a mode the ordinary write carries: a mode change that is
 * not an approval (an approval's mode is written with its status, S-C).
 *
 * @param mode - The settlement.
 */
export function modeOnly(mode: AgentModeSettlement): boolean {
  return mode.grant?.decision.setsMode === true && !mode.grant.decision.approves;
}
