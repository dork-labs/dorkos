/**
 * The agent permission model on the server (spec `agent-permissions`): the one
 * write owner, the audit history, and the boot-time upgrade sweep.
 *
 * @module services/core/permissions
 */
import type { MeshCore } from '@dorkos/mesh';
import type { AgentPermissions } from '@dorkos/shared/permissions';

import { MCP_TOOL_TIERS, type McpToolTier } from '../mcp-tool-tiers.js';
import type { CapabilityRegistry } from '../capabilities/index.js';
import { readAgentPermissionsFromManifest } from '../capabilities/permission-enforcement.js';
import type { ConfigManager } from '../config-manager.js';
import type { ActivityService } from '../../activity/activity-service.js';
import type { PermissionObserver } from './permission-observer.js';
import {
  PermissionService,
  type PermissionActionInfo,
  type PermissionAgentRef,
} from './permission-service.js';

export {
  PermissionError,
  PermissionService,
  type PermissionActionInfo,
  type PermissionAgentRef,
} from './permission-service.js';
export { readRawManifestFile, runPermissionUpgradeSweep } from './permission-upgrade-sweep.js';
export { PermissionObserver } from './permission-observer.js';
export {
  listPermissionHistory,
  personWriter,
  type PermissionWriter,
} from './permission-history.js';

/**
 * Every action an agent can reach, with its area: the registry's capabilities
 * plus the hand-registered MCP tools.
 *
 * @param registry - The composed registry, or `undefined` before it exists.
 */
export function permissionActions(
  registry: CapabilityRegistry | undefined
): PermissionActionInfo[] {
  const capabilities: PermissionActionInfo[] = (registry?.capabilities ?? []).map((cap) => ({
    id: cap.id,
    title: cap.title,
    tier: cap.tier,
    area: cap.area,
    ...(cap.surfaces.mcp ? { toolName: cap.surfaces.mcp.toolName } : {}),
  }));
  const tools: PermissionActionInfo[] = Object.entries(
    MCP_TOOL_TIERS as Record<string, McpToolTier>
  ).map(([id, tool]) => ({
    id,
    title: tool.title,
    tier: tool.tier,
    area: tool.area,
    toolName: id,
  }));
  return [...capabilities, ...tools];
}

/** The live services the production permission service is built over. */
export interface PermissionServiceWiring {
  /** User config. */
  config: ConfigManager;
  /** The agent registry and manifest write-through, absent when Mesh is off. */
  mesh: () => MeshCore | undefined;
  /** The capability registry, composed after the routes are mounted. */
  registry: () => CapabilityRegistry | undefined;
  /** The Activity writer. */
  activity: ActivityService;
  /** Notices changes made to an agent's settings file outside DorkOS. */
  observer: PermissionObserver;
}

/**
 * Read an agent's settings fresh off its manifest, and let the observer compare
 * them with the last value DorkOS saw, so an edit made outside DorkOS is
 * recorded the first time anything reads it. The gate, the tool lists and the
 * permission pages all read through this.
 *
 * @param observer - The observer to report each read to.
 */
export function observedPermissionReader(
  observer: PermissionObserver
): (agentPath: string) => Promise<AgentPermissions | undefined> {
  return async (agentPath) => {
    const permissions = await readAgentPermissionsFromManifest(agentPath);
    await observer.observe(agentPath, permissions);
    return permissions;
  };
}

/**
 * Build the production permission service.
 *
 * @param wiring - The live config, mesh, registry and activity handles.
 */
export function createPermissionService(wiring: PermissionServiceWiring): PermissionService {
  return new PermissionService({
    config: {
      get: () => wiring.config.get('permissions'),
      set: (next) => wiring.config.set('permissions', next),
      trustStop: () => (wiring.config.getDot('runtimes.defaultTrustStop') as string | null) ?? null,
    },
    agents: {
      list: (): PermissionAgentRef[] => {
        const mesh = wiring.mesh();
        if (!mesh) return [];
        return mesh.listWithPaths().map((a) => ({
          id: a.id,
          name: a.name,
          ...(a.displayName ? { displayName: a.displayName } : {}),
          projectPath: a.projectPath,
        }));
      },
      readPermissions: observedPermissionReader(wiring.observer),
      writePermissions: async (agentId: string, next: AgentPermissions | undefined) => {
        const mesh = wiring.mesh();
        if (!mesh)
          throw new Error('The agent registry is not running, so no agent can be changed.');
        const agentPath = mesh.listWithPaths().find((a) => a.id === agentId)?.projectPath;
        const write = async () => {
          await mesh.update(agentId, { permissions: next });
        };
        if (agentPath) await wiring.observer.writing(agentPath, next, write);
        else await write();
      },
    },
    actions: () => permissionActions(wiring.registry()),
    activity: wiring.activity,
  });
}
