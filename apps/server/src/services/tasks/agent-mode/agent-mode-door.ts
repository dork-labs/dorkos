/**
 * What a door that writes a scheduled task does about an agent's mode or
 * approval (DOR-3703): decide it once more right before the write, refuse it
 * whole or let it through, and after the write record what an agent armed
 * where a person will see it.
 *
 * The tool gate decided the same call before any card (`agent-mode-escalation.ts`);
 * this second read is what makes a call that needed a person, and arrived
 * without one, fail here as well.
 *
 * @module services/tasks/agent-mode/agent-mode-door
 */
import type { MeshCore } from '@dorkos/mesh';
import type { Task } from '@dorkos/shared/types';
import { escalatedGrantFor } from '../../core/capabilities/tool-call-escalation.js';
import { currentAuditActor } from '../../audit/audit-context.js';
import type { ScheduleAgentEdits } from '../approvals/task-approvals.js';
import {
  decideAgentModeCall,
  type AgentIdentityResolution,
  type AgentModeCaller,
  type AgentModeDecided,
  type AgentModeSources,
} from './agent-mode-decision.js';
import {
  AGENT_MODE_REFUSAL_ERROR,
  CONTENT_CHANGED_MESSAGE,
  NEEDS_A_PERSON_MESSAGE,
} from './agent-mode-copy.js';
import { agentModeChangeOf } from './agent-mode-change.js';
import { skillFileText } from './agent-mode-binding.js';
import { scheduleContentKey, taskWorkOf } from '../schedule-permission-clamp.js';
import { liveAgentModeSources } from './agent-mode-sources.js';

/** How a caller reached DorkOS, for the audit row (Security ruling 8). */
export type AgentModeCredential = 'in-session' | 'token' | 'api-key' | 'unidentified';

/** An agent's mode or approval that may be written, and how it got through. */
export interface AgentModeGrant {
  /** What the decision made of it. */
  decision: AgentModeDecided;
  /** `card` when a person approved this exact call, `allowed` when a setting did. */
  via: 'card' | 'allowed';
  /** The approval a person answered, when one was. */
  approvalId?: string;
  /** How the caller reached DorkOS. */
  credential: AgentModeCredential;
  /** The task as the decision read it, for an update ({@link agentModeSnapshotOf}). */
  snapshot?: string;
  /** The setter's home folder, when DorkOS can name it (Security ruling C3). */
  setterPath?: string;
  /** How the setter's identity was resolved (Security ruling C3). */
  resolved: AgentIdentityResolution;
  /**
   * The content key of the task the decision read, for an update: the only
   * content a person's yes on its card may be recorded as approving (M1).
   */
  boundContentKey?: string;
  /** Who started the calling turn, as a person reads it (M6): for the notice and the audit row. */
  startedBy?: string;
}

/** What a door should do about one call. */
export type AgentModeSettlement =
  | { refusal: Record<string, unknown>; grant?: undefined }
  | { refusal?: undefined; grant?: AgentModeGrant };

/** One call, as a door hands it over. */
export interface AgentModeDoorCall {
  /** Which write. */
  door: 'create' | 'update';
  /** The raw body (an update's fields, without its `id`). */
  body: Record<string, unknown>;
  /** The exact input object the tool gate saw, so its grant can be read back. */
  input: unknown;
  /** The task as it stands, for an update. */
  task?: Task;
  /** Who last changed it, for an update. */
  edits?: ScheduleAgentEdits | null;
  /** The create's target. */
  target?: string;
  /** Who is calling. */
  caller: AgentModeCaller;
}

/**
 * How the caller reached DorkOS: its own tools in its own chat, an agent token,
 * a per-user key, or nothing DorkOS can name.
 *
 * @param caller - The caller as the surface verified it.
 */
export function credentialKindOf(caller: AgentModeCaller): AgentModeCredential {
  if (caller.structural) return 'in-session';
  const scoped = currentAuditActor()?.credential?.kind;
  if (caller.agentPath || scoped === 'agent-token') return 'token';
  return scoped === 'api-key' ? 'api-key' : 'unidentified';
}

/**
 * Decide one write that may set a mode or approve a task, right before it is
 * written. Nothing to settle answers `{}`.
 *
 * @param call - The write and its caller.
 * @param meshCore - Mesh, for the agents' homes.
 * @param sources - Override for tests; the live sources otherwise.
 */
export async function settleAgentModeCall(
  call: AgentModeDoorCall,
  meshCore: Pick<MeshCore, 'getProjectPath'> | undefined,
  sources: AgentModeSources = liveAgentModeSources(meshCore)
): Promise<AgentModeSettlement> {
  const decision = await decideAgentModeCall(
    {
      door: call.door,
      body: call.body,
      ...(call.task ? { task: call.task } : {}),
      ...(call.edits !== undefined ? { edits: call.edits } : {}),
      ...(call.target !== undefined ? { target: call.target } : {}),
    },
    call.caller,
    sources
  );
  if (decision.kind === 'none') return {};
  if (decision.kind === 'refuse') return { refusal: decision.body };
  // Only the gate lets a call through: a call it did not decide as this action,
  // or one that needs a person and came without their yes, is refused here
  // whatever this second reading says (a door never grants on its own).
  const noted = escalatedGrantFor(call.input);
  const gated =
    noted !== undefined &&
    noted.actionId === decision.primary &&
    (decision.state === 'allowed' || noted.via === 'card');
  if (!gated) return refusal('needs_a_person', NEEDS_A_PERSON_MESSAGE);
  // The person approved the task as it was then; it must still be that task.
  if (noted.change !== agentModeChangeOf(call, decision, meshCore, call.caller.agentPath)) {
    return refusal('task_changed', CONTENT_CHANGED_MESSAGE);
  }
  return {
    grant: {
      decision,
      via: noted.via,
      credential: credentialKindOf(call.caller),
      resolved: call.caller.resolved ?? (call.caller.agentPath ? 'home' : 'unidentified'),
      ...(call.caller.agentPath ? { setterPath: call.caller.agentPath } : {}),
      ...(noted.approvalId ? { approvalId: noted.approvalId } : {}),
      ...(call.task
        ? {
            snapshot: agentModeSnapshotOf(call.task, call.edits ?? null, decision),
            // The content the card showed, which is all a person's yes approves (M1).
            boundContentKey: scheduleContentKey(taskWorkOf(call.task)),
          }
        : {}),
    },
  };
}

function refusal(code: string, message: string): AgentModeSettlement {
  return { refusal: { error: AGENT_MODE_REFUSAL_ERROR, code, message } };
}

/**
 * What an approval was decided against, as one comparable string: the work,
 * the mode (unless the call sets it), the status, the agent it runs as, and who
 * last changed it. Read again with no await before the approval is written
 * (`armAgentApproval`), so an edit that lands while the call was in flight
 * stops it rather than being armed with it.
 *
 * @param task - The task.
 * @param edits - Who last changed it.
 * @param decision - What the call sets.
 */
export function agentModeSnapshotOf(
  task: Task,
  edits: ScheduleAgentEdits | null,
  decision: Pick<AgentModeDecided, 'setsMode'>
): string {
  return JSON.stringify([
    scheduleContentKey(taskWorkOf(task)),
    // The SKILL file as it is on disk: a rewrite during the call is a change (N-b).
    skillFileText(task.filePath),
    decision.setsMode ? null : task.permissionMode,
    task.status,
    task.agentId ?? null,
    edits?.lastEditedByAgentPath ?? null,
    edits?.lastEditedBySessionId ?? null,
  ]);
}

/**
 * Whether a grant may override the rule that an agent changes only its own
 * schedule (DOR-3640 R1): a person approved this exact call on a card, and it
 * sets only the mode or the approval. Allowed alone never covers another
 * agent's task (Security ruling 6).
 *
 * @param grant - The settled grant.
 * @param body - The write body.
 */
export function grantCoversOthersTask(grant: AgentModeGrant | undefined, body: object): boolean {
  if (grant?.via !== 'card') return false;
  return Object.keys(body).every((k) => k === 'id' || k === 'permissionMode' || k === 'status');
}
