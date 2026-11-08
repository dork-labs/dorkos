/**
 * How the `tasks_create` and `tasks_update` tools decide a write for ANOTHER agent (DOR-3938):
 * only the in-session server, for a verified agent whose turn runs at Full autonomy unmarked.
 * The rule itself is `tasks/approvals/cross-agent.ts`; this is the tools' side of it.
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/task-tool-cross-agent
 */
import type { PermissionMode, Task, UpdateTaskRequest } from '@dorkos/shared/types';
import type { McpToolDeps } from '../types.js';
import {
  agentNameOf,
  auditCrossAgentTask,
  capModeAtAgentLevel,
  CROSS_AGENT_NEEDS_FULL_MESSAGE,
  crossAgentRefusal,
  isForAnotherAgent,
  type CrossAgentRefusal,
} from '../../../../tasks/approvals/cross-agent.js';
import { capabilitiesForTaskRuntime } from '../../../../tasks/scheduled-run-power.js';
import {
  callerAgentPathOf,
  type CallerAgentResolver,
  type TaskProvenanceResolver,
} from './task-tool-parts.js';

/** What a write for another agent may do. */
export type CrossAgentDecision =
  /** The target is the caller, `global`, or the caller is not one this rule can vouch for. */
  | { kind: 'own' }
  /** Another agent, and the calling turn may write for it. */
  | { kind: 'allowed'; callerAgentPath: string }
  /** Another agent, and the calling turn may not. */
  | { kind: 'refused'; refusal: CrossAgentRefusal };

/**
 * Decide a write whose target (a create's `target`, or the stored agent of the task an update
 * changes) may be another agent. The external `/mcp` server has no turn to read, so it never
 * reaches `allowed`: its writes keep today's rule.
 *
 * @param deps - The tool dependencies, for Mesh.
 * @param target - The agent id the write is for, `global`, or `null` for a global task.
 * @param resolveProvenance - The in-session caller; absent on the external server.
 * @param callerAgent - The external caller's verified home.
 */
export function decideCrossAgent(
  deps: McpToolDeps,
  target: string | null | undefined,
  resolveProvenance: TaskProvenanceResolver | undefined,
  callerAgent: CallerAgentResolver | undefined
): CrossAgentDecision {
  const provenance = resolveProvenance?.() ?? {};
  const { callerAgentPath } = callerAgentPathOf(provenance, callerAgent);
  if (!isForAnotherAgent(target, callerAgentPath, deps.meshCore)) return { kind: 'own' };
  // Only a verified agent in a chat of its own: the external server has no turn to read.
  if (resolveProvenance === undefined || callerAgentPath === undefined || !provenance.sessionId) {
    return {
      kind: 'refused',
      refusal: { error: CROSS_AGENT_NEEDS_FULL_MESSAGE, code: 'cross_agent_needs_full' },
    };
  }
  const refusal = crossAgentRefusal({
    sessionId: provenance.sessionId,
    ...(provenance.turnSessionIds ? { turnSessionIds: provenance.turnSessionIds } : {}),
    agentPath: callerAgentPath,
  });
  return refusal ? { kind: 'refused', refusal } : { kind: 'allowed', callerAgentPath };
}

/**
 * The mode an edit for another agent saves, capped at that agent's own level on the task's
 * runtime (Security's Must 4): an edit can never raise another agent's task past it.
 *
 * @param deps - The tool dependencies, for Mesh.
 * @param task - The task as it stands.
 * @param mode - The mode the edit would save.
 */
export async function capEditMode(
  deps: McpToolDeps,
  task: Pick<Task, 'agentId' | 'runtime'>,
  mode: string
): Promise<string> {
  const agentPath = task.agentId ? deps.meshCore?.getProjectPath(task.agentId) : undefined;
  return capModeAtAgentLevel(
    mode,
    agentPath ?? undefined,
    capabilitiesForTaskRuntime(task.runtime)
  );
}

/**
 * Whether a decision is the refusal of a marked turn (Security's Must 2), which is told to the
 * caller in its own words. A turn below Full keeps the refusal it always had.
 *
 * @param decision - The decision.
 */
export function isMarkedRefusal(
  decision: CrossAgentDecision
): decision is { kind: 'refused'; refusal: CrossAgentRefusal } {
  return decision.kind === 'refused' && decision.refusal.code === 'cross_agent_marked_turn';
}

/**
 * " for <agent>" when the task was made for another agent, for the Activity line; else empty.
 *
 * @param deps - The tool dependencies, for Mesh.
 * @param decision - The decision.
 * @param task - The task made.
 */
export function forWhomOf(
  deps: McpToolDeps,
  decision: CrossAgentDecision,
  task: Pick<Task, 'agentId'>
): string {
  return decision.kind === 'allowed' ? ` for ${agentNameOf(deps.meshCore, task.agentId)}` : '';
}

/**
 * Hold an edit for another agent at that agent's own level (Security's Must 4): the patch's mode,
 * or the task's current one, capped, and set on the patch only when the cap lowers it.
 *
 * @param deps - The tool dependencies, for Mesh.
 * @param decision - The decision.
 * @param existing - The task as it stands.
 * @param patch - The edit, changed in place.
 */
export async function capPatch(
  deps: McpToolDeps,
  decision: CrossAgentDecision,
  existing: Task,
  patch: UpdateTaskRequest
): Promise<void> {
  if (decision.kind !== 'allowed') return;
  // A switch-off only takes power away, and anyone may make one: it is never refused for the cap.
  const keys = Object.keys(patch);
  if (keys.length === 1 && keys[0] === 'enabled' && patch.enabled === false) return;
  const asked = patch.permissionMode ?? existing.permissionMode;
  const capped = (await capEditMode(deps, existing, asked)) as PermissionMode;
  if (capped !== asked) patch.permissionMode = capped;
}

/**
 * Audit an edit made for another agent: who changed it, for which agent, at what mode.
 *
 * @param deps - The tool dependencies, for Mesh.
 * @param decision - The decision.
 * @param updated - The task after the edit.
 */
export function auditEdit(deps: McpToolDeps, decision: CrossAgentDecision, updated: Task): void {
  if (decision.kind !== 'allowed') return;
  auditCrossAgentTask(updated, 'modify', decision.callerAgentPath, deps.meshCore);
}
