/**
 * The mode a message from one of our agents starts the answering agent's turn
 * at (spec `trusted-by-default-flip` §4.4).
 *
 * Under trusted-by-default, a message one of our agents sends another runs the
 * way the answering agent's own new conversations do: at its configured Files &
 * commands stop. The relay adapter holds that turn to the level the SENDER's
 * own turn ran at, stamped on the envelope by the server, so the turn runs at
 * the stricter of the two and power still flows downstream, never up.
 *
 * The question is the one a room turn and a scheduled run already ask, through
 * the same call (`resolveUnattendedPermissionMode`), so an agent answering a
 * colleague, a room and a schedule answers at the same level.
 *
 * @module services/relay/agent-dm-mode
 */
import type { AgentDmModeResolver } from '@dorkos/relay';
import type { PermissionMode } from '@dorkos/shared/schemas';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { readAgentExecutionDefaults, resolveUnattendedPermissionMode } from '../session/index.js';

/** Where the resolver reads a runtime's declared modes; the live registry by default. */
export interface AgentDmModeSources {
  /** The runtime's capability profile, or `undefined` when it is not registered. */
  capabilitiesOf: (runtimeType: string) => RuntimeCapabilities | undefined;
}

const LIVE_SOURCES: AgentDmModeSources = {
  capabilitiesOf: (runtimeType) =>
    runtimeRegistry.has(runtimeType)
      ? runtimeRegistry.get(runtimeType).getCapabilities()
      : undefined,
};

/**
 * Build the resolver the relay adapter asks for an agent DM's mode.
 *
 * Answers the answering agent's own stop (its manifest's Files & commands,
 * then the runtime's and the global default), as that runtime's mode id, or
 * `undefined` when nothing is configured or the runtime declares no mode at
 * that stop.
 *
 * @param sources - Where runtime profiles come from; the live registry by default.
 */
export function createAgentDmModeResolver(
  sources: AgentDmModeSources = LIVE_SOURCES
): AgentDmModeResolver {
  return async ({ agentDirectory, runtimeType }) => {
    const capabilities = sources.capabilitiesOf(runtimeType);
    if (!capabilities) return undefined;
    const agentStop = (await readAgentExecutionDefaults(agentDirectory)).filesAndCommands;
    // A declared mode id of the runtime that answers, which is what a relay
    // turn's per-send mode names.
    return resolveUnattendedPermissionMode({
      capabilities,
      ...(agentStop ? { agent: { filesAndCommands: agentStop } } : {}),
    }) as PermissionMode | undefined;
  };
}
