import type { MeshCore } from '@dorkos/mesh';
import type { UninstallAgentRegistry } from './uninstall.js';

/**
 * The agent-registry surface the marketplace flows use to take an agent off the
 * team (an uninstalled agent package, or an agent a different package with the
 * same name replaces) and to put it back when an uninstall rolls back
 * (DOR-2245).
 *
 * Both halves go through `MeshCore`, never around it, so a removal fires the
 * same `onAgentsChanged` observer as every other identity write and every open
 * sidebar drops the row at once instead of after the reconciler's grace sweep
 * (DOR-2066).
 *
 * @param getMeshCore - Reads Mesh lazily: it is absent when Mesh is switched
 *   off, and the server assigns it after the flows are built.
 * @returns The registry surface `UninstallFlow` and `AgentInstallFlow` take.
 */
export function createMeshAgentRegistry(
  getMeshCore: () => MeshCore | undefined
): UninstallAgentRegistry {
  return {
    unregisterAtPath: async (projectPath) => {
      const meshCore = getMeshCore();
      const agent = meshCore?.getByPath(projectPath);
      if (!meshCore || !agent) return null;
      const { manifestKept } = await meshCore.unregister(agent.id);
      return { id: agent.id, directoryDenied: manifestKept };
    },
    restoreAtPath: async (projectPath) => {
      await getMeshCore()?.syncFromDisk(projectPath);
    },
  };
}
