/**
 * Who proposed a schedule, resolved when the schedule is read.
 *
 * The row stores the proposing session's working directory, never a name. A
 * name written at proposal time would outlive a rename and — worse — survive a
 * revocation, so the approval card could keep crediting an agent the operator
 * has already switched off. Resolving on read means the card says what is true
 * now, and says nothing when nothing is true.
 *
 * Every function here degrades to `null` rather than throwing. Attribution is a
 * side channel: a schedule must still be listable, creatable, and approvable
 * when the identity service is absent (unit tests, a server built without a
 * database) or when its lookup fails.
 *
 * @module services/tasks/task-provenance
 */
import type { Task } from '@dorkos/shared/types';
import { getAgentIdentityService } from '../core/agent-identity/index.js';
import { logger } from '../../lib/logger.js';

/**
 * The display name of the agent rooted at `agentPath`, or `null`.
 *
 * `null` covers every "we do not know" case alike — no path recorded, no
 * identity service wired, no live token for that directory, or a failed read.
 * Callers render their own fallback rather than being handed a placeholder that
 * would be indistinguishable from a real name.
 *
 * @param agentPath - The proposing session's working directory.
 * @returns The agent's display name, or `null` when none resolves.
 */
export async function resolveProposerName(
  agentPath: string | null | undefined
): Promise<string | null> {
  if (!agentPath) return null;

  const service = getAgentIdentityService();
  if (!service) return null;

  try {
    const identity = await service.describeAgent(agentPath);
    // A revoked agent is not credited, which is the behavior this has always
    // had and a deliberate one: switching an agent off stops its name appearing
    // beside work. It used to fall out of `describeAgent` answering `undefined`;
    // that method now NAMES a revoked agent, because the capability gate has to
    // tell one from a stranger (DOR-486), so the choice is made here instead —
    // where it is a product decision rather than a side effect.
    if (!identity || identity.inactive) return null;
    return identity.displayName ?? null;
  } catch (err) {
    logger.debug('[Tasks] Could not resolve who proposed a schedule', {
      agentPath,
      err: String(err),
    });
    return null;
  }
}

/**
 * The same task, carrying the proposer's name if one resolves.
 *
 * @param task - The task as the store returned it.
 * @returns A copy with `proposedByName` filled in, or the task unchanged.
 */
export async function withProposerName(task: Task): Promise<Task> {
  const proposedByName = await resolveProposerName(task.proposedByAgentPath);
  return proposedByName === null ? task : { ...task, proposedByName };
}

/**
 * {@link withProposerName} over a whole list, one lookup per distinct directory.
 *
 * The list endpoint is the hot path — every cockpit poll reads every schedule —
 * and several schedules routinely come from the same agent, so the lookups are
 * deduplicated by path rather than run once per row.
 *
 * @param tasks - The tasks as the store returned them.
 * @returns The same tasks in the same order, with names filled in where they resolve.
 */
export async function withProposerNames(tasks: Task[]): Promise<Task[]> {
  const paths = [...new Set(tasks.map((t) => t.proposedByAgentPath).filter((p) => p !== null))];
  if (paths.length === 0) return tasks;

  const resolved = new Map(
    await Promise.all(paths.map(async (path) => [path, await resolveProposerName(path)] as const))
  );

  return tasks.map((task) => {
    const name = task.proposedByAgentPath ? resolved.get(task.proposedByAgentPath) : null;
    return name ? { ...task, proposedByName: name } : task;
  });
}
