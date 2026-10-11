/**
 * The registered agents that have a project on disk. Split out of the server's
 * `index.ts` so that file stays inside its line budget.
 *
 * @module services/mesh/roots/registered-agent-roots
 */
import type { MeshCore } from '@dorkos/mesh';

/**
 * Every registered agent that has a project on disk, as the legacy migration
 * wants them.
 *
 * Lives here rather than inline because the filter is the interesting part: an
 * agent with no resolvable project path has no `.dork/tasks/` to migrate and no
 * `.agents/skills/` to migrate into, and asking about it would only produce a
 * pair of ENOENTs.
 *
 * @param meshCore - The registry, absent when Mesh is switched off.
 */
export function registeredAgentRoots(
  meshCore: MeshCore | undefined
): { agentId: string; projectPath: string }[] {
  if (!meshCore) return [];
  return meshCore.list().flatMap((agent) => {
    const projectPath = meshCore.getProjectPath(agent.id);
    return projectPath ? [{ agentId: agent.id, projectPath }] : [];
  });
}
