/**
 * Registering again the agents an interrupted uninstall's recovery restored.
 * Split out of the server's `index.ts` so that file stays inside its line budget.
 *
 * @module services/marketplace/restored-agents
 */
import type { MeshCore } from '@dorkos/mesh';
import { logger, logError } from '../../lib/logger.js';

/** Agent folders recovery restored before Mesh started, registered once it has. */
const agentRootsAwaitingMesh: string[] = [];

/**
 * Register again the agents whose interrupted uninstall recovery rolled back
 * (DOR-2245): their `agent.json` is back, but the uninstall had already taken
 * them off the team. The global sweep runs before Mesh exists, so its roots
 * wait for {@link flushRestoredAgents}.
 *
 * @param roots - The restored agent roots a sweep reported.
 * @param meshCore - The registry, absent until Mesh has started.
 */
export function registerRestoredAgents(
  roots: readonly string[],
  meshCore: MeshCore | undefined
): void {
  if (!meshCore) {
    agentRootsAwaitingMesh.push(...roots);
    return;
  }
  for (const root of roots) {
    meshCore.syncFromDisk(root).catch((err: unknown) => {
      logger.warn(`[Marketplace] Could not register the restored agent at ${root}`, logError(err));
    });
  }
}

/**
 * Register the agents {@link registerRestoredAgents} held until Mesh started.
 *
 * @param meshCore - The registry, now started.
 */
export function flushRestoredAgents(meshCore: MeshCore): void {
  registerRestoredAgents(agentRootsAwaitingMesh.splice(0), meshCore);
}
