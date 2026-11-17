/** The scheduler's existing placement chain and desk guard, extracted without policy changes. */
import type { Task } from '@dorkos/shared/types';
import type { MeshCore } from '@dorkos/mesh';
import { resolveSessionCwd } from '../../workspace/resolve-session-cwd.js';
import { assertOwnDesk, deskBindingFor } from '../../core/agent-identity/index.js';
import { guardRunPlacement, unregisteredAgentError } from './run-place-guard.js';

/**
 * Resolve an agent's desk or the unchanged server cwd for an agent-less task.
 * @param task - The schedule whose agent binding is resolved.
 * @param meshCore - The scheduler's actual registry, absent when Mesh is unavailable.
 */
export async function resolveTaskRunPlacement(
  task: Pick<Task, 'id' | 'agentId'>,
  meshCore: Pick<MeshCore, 'getProjectPath'> | null | undefined
): Promise<{ cwd: string; agentPath?: string }> {
  if (task.agentId && meshCore) {
    const projectPath = meshCore.getProjectPath(task.agentId);
    if (!projectPath) {
      throw unregisteredAgentError(task.agentId, task.id);
    }
    const resolved = await resolveSessionCwd({ agentPath: projectPath });
    // **The desk guard** (spec `agent-home-desk` §3.4, DOR-2356): a run for
    // this agent never stands in another agent's home, a copy of it, or a
    // room's folder. A refusal throws, and the run is recorded failed with
    // the reason — nothing reaches a runtime.
    assertOwnDesk(projectPath, resolved.cwd, deskBindingFor(resolved));
    return guardRunPlacement({ cwd: resolved.cwd, agentPath: projectPath });
  }
  // Unchanged: `process.cwd()`, not `DEFAULT_CWD`. The two are the same in
  // every deployment that does not set `DORKOS_DEFAULT_CWD`, and routing an
  // agent-less task through the chain's default rung would quietly move the
  // ones where they differ.
  return guardRunPlacement({ cwd: process.cwd() });
}
