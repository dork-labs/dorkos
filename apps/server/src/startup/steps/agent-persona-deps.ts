/**
 * What the persona move (`agent.migrate_persona`, `services/mesh/doors/agent-persona-capability.ts`)
 * reads, composed here so the mesh domain imports neither the agent home nor the
 * folder refusals (DOR-4978, the services import boundary).
 *
 * @module startup/steps/agent-persona-deps
 */
import { validateBoundaryOrDorkHome } from '../../lib/boundary.js';
import {
  homeOf,
  readHomeManifest,
  resolveAgentHome,
} from '../../services/core/agent-identity/index.js';
import { boundaryToolError } from '../../services/core/directory/path-refusal.js';
import type { AgentHomeDeps } from '../../services/mesh/doors/agent-persona-capability.js';

/**
 * The agent a folder belongs to: its home, through any checkout, inside the
 * folders DorkOS may use, with its manifest. A refused path throws the
 * capability refusal the hand route's answer maps to.
 */
export const agentPersonaDeps: AgentHomeDeps = {
  async agentAt(rawPath) {
    let resolved: string;
    try {
      resolved = await validateBoundaryOrDorkHome(rawPath);
    } catch (err) {
      throw boundaryToolError(err) ?? err;
    }
    const home = homeOf(resolveAgentHome(resolved));
    const manifest = home ? await readHomeManifest(home) : null;
    return home && manifest ? { home, manifest: manifest as Record<string, unknown> } : null;
  },
};
