/**
 * The registered agents boot hands to the legacy task and skill migration, moved out of the
 * server's bootstrap unchanged.
 *
 * @module agent-roots
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
