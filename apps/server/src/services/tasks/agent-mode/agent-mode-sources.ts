/**
 * Where the agent-mode decision reads the rest of DorkOS from (DOR-3703), wired
 * to the live services. Tests build their own {@link AgentModeSources}.
 *
 * @module services/tasks/agent-mode/agent-mode-sources
 */
import type { MeshCore } from '@dorkos/mesh';
import { permissionGateSources } from '../../core/capabilities/permission-enforcement.js';
import { getSessionStartedByStore } from '../../session/origin/session-started-by-store.js';
import { resolveAgentLaunchLevel } from '../../session/resolution/agent-launch-level.js';
import { capabilitiesForTaskRuntime } from '../scheduled-run-power.js';
import { lastTurnLevelOf } from '../../core/turn-power/turn-levels.js';
import type { AgentModeSources } from './agent-mode-decision.js';

/**
 * The live sources, over one Mesh.
 *
 * @param meshCore - Mesh, which names each agent's home; absent when it is off.
 */
export function liveAgentModeSources(
  meshCore: Pick<MeshCore, 'getProjectPath'> | undefined
): AgentModeSources {
  return {
    declaredModes: (runtime) => {
      const modes = capabilitiesForTaskRuntime(runtime)?.permissionModes;
      return modes?.supported ? modes : undefined;
    },
    agentLevelMode: async (agentPath, runtime) =>
      (
        await resolveAgentLaunchLevel({
          agentPath,
          capabilities: capabilitiesForTaskRuntime(runtime),
        })
      ).mode,
    agentPathOf: (agentId) => meshCore?.getProjectPath(agentId) ?? undefined,
    readConfig: () => permissionGateSources().readConfig(),
    readAgentPermissions: (agentPath) => permissionGateSources().readAgentPermissions(agentPath),
    startedBy: (sessionId) =>
      getSessionStartedByStore()?.get(sessionId)?.startedBySessionId ?? null,
    // The level the chat's latest turn really ran at, a hold included (DOR-3703, S3).
    turnLevelOf: (sessionId) => lastTurnLevelOf(sessionId),
  };
}
