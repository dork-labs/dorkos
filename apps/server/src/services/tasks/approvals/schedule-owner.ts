/**
 * Whose schedule an agent may make, change and arm (DOR-3640 R1). A schedule
 * runs as the agent it is filed under, so whoever picks its target picks who
 * its runs act as. An agent may file one only under itself or `global`, may
 * change only its own (or a global one no other agent made), and only one
 * filed under itself ever arms without a person, even on a Trusted install.
 *
 * Asked by `tasks_create`, `tasks_update`, `POST /api/tasks` and
 * `PATCH /api/tasks/:id`, so the doors cannot drift. A person is never asked.
 *
 * @module services/tasks/approvals/schedule-owner
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MeshCore } from '@dorkos/mesh';
import type { AuditChange } from '@dorkos/shared/audit-schemas';
import type { Task } from '@dorkos/shared/types';
import { recordAudit } from '../../audit/audit-trail.js';
import { logError, logger } from '../../../lib/logger.js';
import { agentSchedulesArmWithoutAsking } from './agent-trust.js';

/** The refusal for a schedule an agent files under another agent. */
export const NOT_YOUR_AGENT_MESSAGE =
  'An agent can schedule a task only for itself. Use your own agent id as the target, or "global".';

/** The refusal for a change to another agent's schedule. */
export const NOT_YOUR_SCHEDULE_MESSAGE =
  'That scheduled task belongs to another agent. Only that agent or a person can change it.';

/** A folder's real path, or its resolved spelling when it cannot be read. */
function realOr(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The Mesh id of the agent whose home is `agentPath`, or `undefined` when no
 * registered agent lives there.
 *
 * @param meshCore - Mesh, which names each registered home.
 * @param agentPath - The calling agent's verified home.
 */
export function agentIdOfHome(
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  agentPath: string
): string | undefined {
  const agents = meshCore?.listWithPaths() ?? [];
  const exact = agents.find((a) => a.projectPath === agentPath);
  if (exact) return exact.id;
  // Only an unambiguous match by real path: a home that is a link to another
  // agent's would otherwise be read as that agent.
  const own = realOr(agentPath);
  const matches = agents.filter((a) => realOr(a.projectPath) === own);
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/**
 * Whether an agent may file a schedule under `target`: its own id, or `global`.
 *
 * @param target - The target the request names.
 * @param callerId - The calling agent's Mesh id, when Mesh names it.
 */
export function mayTarget(target: string, callerId: string | undefined): boolean {
  return target === 'global' || (callerId !== undefined && target === callerId);
}

/**
 * Whether a schedule an agent files under `target` may arm without a person:
 * only one filed under that agent itself.
 *
 * @param target - The schedule's target (or its stored agent id, `null` for global).
 * @param callerId - The calling agent's Mesh id, when Mesh names it.
 */
export function runsAsItsCreator(target: string | null, callerId: string | undefined): boolean {
  return callerId !== undefined && target === callerId;
}

/**
 * Whether the calling agent may change this schedule: one filed under itself,
 * or a global one no other agent made.
 *
 * @param task - The schedule as it stands.
 * @param callerPath - The calling agent's verified home.
 * @param callerId - Its Mesh id, when Mesh names it.
 */
export function ownsSchedule(
  task: Pick<Task, 'agentId' | 'proposedByAgentPath'>,
  callerPath: string,
  callerId: string | undefined
): boolean {
  if (task.agentId) return callerId !== undefined && task.agentId === callerId;
  return !task.proposedByAgentPath || realOr(task.proposedByAgentPath) === realOr(callerPath);
}

/**
 * A prompt as the audit log keeps it: a SHA-256 of its text, never the text.
 *
 * @param prompt - The prompt.
 */
export function promptHashOf(prompt: string | null | undefined): string {
  return `sha256:${createHash('sha256')
    .update(prompt ?? '', 'utf8')
    .digest('hex')}`;
}

/** The fields an update can change that the audit row names. */
const AUDITED_FIELDS = [
  'name',
  'displayName',
  'description',
  'prompt',
  'cron',
  'enabled',
  'timezone',
  'maxRuntime',
  'sticky',
  'runtime',
  'model',
  'effort',
  'account',
  'permissionMode',
  'status',
] as const satisfies readonly (keyof Task)[];

/**
 * What an update changed, field by field, for its audit row: before and after
 * for each field that changed, and a prompt only by its hashes.
 *
 * @param before - The schedule before the update.
 * @param after - The schedule after it.
 */
export function scheduleChanges(before: Task, after: Task): AuditChange[] {
  return AUDITED_FIELDS.filter((field) => before[field] !== after[field]).map((field) =>
    field === 'prompt'
      ? { field, before: promptHashOf(before.prompt), after: promptHashOf(after.prompt) }
      : { field, before: before[field], after: after[field] }
  );
}

/**
 * Record a schedule update in the audit log: which fields changed, before and
 * after, and a prompt only by its hashes. Who acted comes from the caller's
 * audit scope. An update that changed nothing records nothing.
 *
 * @param before - The schedule before the update.
 * @param after - The schedule after it.
 */
export function auditScheduleUpdate(before: Task, after: Task): void {
  // The edit already happened; a row that cannot be written must not undo it.
  try {
    recordScheduleUpdate(before, after);
  } catch (err) {
    logger.warn('[tasks] could not record a schedule update', logError(err));
  }
}

function recordScheduleUpdate(before: Task, after: Task): void {
  const change = scheduleChanges(before, after);
  if (change.length === 0) return;
  recordAudit({
    action: 'tasks.update',
    operation: 'modify',
    target: { type: 'task', id: after.id, name: after.displayName ?? after.name },
    outcome: 'ok',
    change,
    // The name it had, so a rename still says which schedule it was.
    summary: `Changed ${change.map((c) => c.field).join(', ')} on ${before.displayName ?? before.name}`,
  });
}

/**
 * Who is changing a schedule: the person, an agent DorkOS verified (by its
 * home), or a caller DorkOS cannot name (an in-session chat with no identity,
 * a revoked or expired token, a key).
 */
export type ScheduleEditor =
  | { readonly kind: 'person' }
  | { readonly kind: 'agent'; readonly agentPath: string }
  | { readonly kind: 'unidentified' };

/** The refusal for a caller DorkOS cannot name, changing an agent's schedule. */
export const UNIDENTIFIED_EDITOR_MESSAGE =
  "DorkOS can't tell which agent is asking, so it can't change an agent's scheduled task.";

/**
 * What an edit to this schedule may do for the caller (DOR-3640 R1).
 *
 * - A person: anything, as before; this rule never asks.
 * - Anyone else may pause any schedule (`enabled: false` alone), which only
 *   ever takes power away.
 * - An agent may change only its own schedule, or a global one no other agent
 *   made; only its own stays live through the edit, on a Trusted install.
 * - A caller DorkOS cannot name may change no schedule an agent filed or made.
 *
 * @param task - The schedule as it stands.
 * @param editor - Who is changing it.
 * @param meshCore - Mesh, which names each registered home.
 * @param patch - The fields the edit sets.
 */
export function scheduleEdit(
  task: Task,
  editor: ScheduleEditor,
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  patch: object
): { refusal?: { error: string; code: string }; armsAgentWork: boolean } {
  if (editor.kind === 'person') return { armsAgentWork: false };
  const fields = Object.keys(patch).filter((key) => key !== 'id');
  const pausesOnly =
    fields.length === 1 &&
    fields[0] === 'enabled' &&
    (patch as { enabled?: unknown }).enabled === false;
  if (pausesOnly) return { armsAgentWork: false };
  if (editor.kind === 'unidentified') {
    return task.agentId || task.proposedByAgentPath
      ? {
          refusal: { error: UNIDENTIFIED_EDITOR_MESSAGE, code: 'not_your_schedule' },
          armsAgentWork: false,
        }
      : { armsAgentWork: false };
  }
  const callerId = agentIdOfHome(meshCore, editor.agentPath);
  if (!ownsSchedule(task, editor.agentPath, callerId)) {
    return {
      refusal: { error: NOT_YOUR_SCHEDULE_MESSAGE, code: 'not_your_schedule' },
      armsAgentWork: false,
    };
  }
  return {
    armsAgentWork: runsAsItsCreator(task.agentId, callerId) && agentSchedulesArmWithoutAsking(true),
  };
}
