/**
 * The level a new chat of one agent starts at when nobody is watching it: the
 * agent's own Files & commands stop (held to what a person set, DOR-3107), else
 * its runtime's stop, else the global one, put through that runtime's modes.
 *
 * One function, so the room turn that launches at this level and the profile's
 * Level row that reports it cannot come to disagree. Both used to be the same
 * two calls written out at each site; a second copy is how a report drifts
 * from what actually runs.
 *
 * @module services/session/resolution/agent-launch-level
 */
import type { PermissionStop, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { PermissionModeId } from '@dorkos/shared/types';
import {
  readAgentExecutionDefaults,
  resolveUnattendedDefaultStop,
  resolveUnattendedPermissionMode,
} from './resolve-session-defaults.js';

/** What a launch resolves for one agent. */
export interface AgentLaunchLevel {
  /** The deciding stop, or `null` when nothing is configured anywhere. */
  stop: PermissionStop | null;
  /** That stop as the runtime's mode id, or `undefined` when the runtime decides. */
  mode: PermissionModeId | undefined;
}

/**
 * Resolve the level a new unattended chat of this agent launches at.
 *
 * The agent's stop is read through `readAgentExecutionDefaults`, which reads
 * it through the permission gate's narrowing reader: an arriving agent's
 * unscreened file is narrowed, and a screened one never rises past what a
 * person set. Nothing here reads the manifest directly.
 *
 * @param opts.agentPath - The agent's project directory.
 * @param opts.capabilities - The runtime the chat launches on. `undefined` (an
 *   unregistered runtime) answers no mode, as `resolveUnattendedPermissionMode` does.
 */
export async function resolveAgentLaunchLevel(opts: {
  agentPath: string;
  capabilities: RuntimeCapabilities | undefined;
}): Promise<AgentLaunchLevel> {
  const { filesAndCommands } = await readAgentExecutionDefaults(opts.agentPath);
  const agent = filesAndCommands ? { agent: { filesAndCommands } } : {};
  return {
    stop: resolveUnattendedDefaultStop({
      configSection: opts.capabilities?.settings.configSection ?? null,
      ...agent,
    }),
    mode: resolveUnattendedPermissionMode({ capabilities: opts.capabilities, ...agent }),
  };
}
