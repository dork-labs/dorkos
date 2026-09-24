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
  type PermissionPatch,
  type PermissionServiceDeps,
} from './permission-service.js';
export {
  PERMISSION_UPGRADE_STEPS,
  readRawManifestFile,
  runPermissionUpgradeSweep,
  type PermissionUpgradeStep,
  type PermissionUpgradeSweepDeps,
} from './permission-upgrade-sweep.js';
export {
  LOCAL_TRUST_ACTOR_DETAIL,
  LOCAL_TRUST_ACTOR_LABEL,
  UPGRADE_WRITER,
  describePermissionChanges,
  listPermissionHistory,
  personWriter,
  recordPermissionChange,
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
  }));
  const tools: PermissionActionInfo[] = Object.entries(
    MCP_TOOL_TIERS as Record<string, McpToolTier>
  ).map(([id, tool]) => ({ id, title: tool.title, tier: tool.tier, area: tool.area }));
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
      readPermissions: readAgentPermissionsFromManifest,
      writePermissions: async (agentId: string, next: AgentPermissions | undefined) => {
        const mesh = wiring.mesh();
        if (!mesh)
          throw new Error('The agent registry is not running, so no agent can be changed.');
        await mesh.update(agentId, { permissions: next });
      },
    },
    actions: () => permissionActions(wiring.registry()),
    activity: wiring.activity,
  });
}
