import { useMemo } from 'react';
import { useCurrentAgent } from './use-current-agent';
import { useRelayEnabled } from '@/layers/entities/relay';
import { usePulseEnabled } from '@/layers/entities/pulse';

/**
 * The three possible states for an agent tool chip.
 *
 * - `enabled`: Feature flag on and agent has not disabled this group.
 * - `disabled-by-agent`: Agent manifest explicitly disables this group.
 * - `disabled-by-server`: Server feature flag is off; agent override is irrelevant.
 */
export type ChipState = 'enabled' | 'disabled-by-agent' | 'disabled-by-server';

/** Per-domain tool status for a given agent. */
export interface AgentToolStatus {
  pulse: ChipState;
  relay: ChipState;
  mesh: ChipState;
  adapter: ChipState;
}

/**
 * Resolve per-domain tool chip state for the agent at the given project path.
 *
 * Merges per-agent `enabledToolGroups` overrides with server feature flags:
 * - `disabled-by-server` wins over all agent settings (relay/pulse feature gate).
 * - `disabled-by-agent` applies when the agent manifest explicitly sets the key to `false`.
 * - `enabled` when neither gate fires.
 * - Mesh has no server feature flag — only agent-level disable is possible.
 *
 * @param projectPath - Working directory path for the agent to look up.
 */
export function useAgentToolStatus(projectPath: string | null): AgentToolStatus {
  const { data: agent } = useCurrentAgent(projectPath);
  const relayEnabled = useRelayEnabled();
  const pulseEnabled = usePulseEnabled();

  return useMemo((): AgentToolStatus => {
    const groups = agent?.enabledToolGroups ?? {};

    return {
      pulse: !pulseEnabled
        ? 'disabled-by-server'
        : groups.pulse === false
          ? 'disabled-by-agent'
          : 'enabled',
      relay: !relayEnabled
        ? 'disabled-by-server'
        : groups.relay === false
          ? 'disabled-by-agent'
          : 'enabled',
      // Mesh has no server feature flag — only agent-level disable applies.
      mesh: groups.mesh === false ? 'disabled-by-agent' : 'enabled',
      adapter: !relayEnabled
        ? 'disabled-by-server'
        : groups.adapter === false
          ? 'disabled-by-agent'
          : 'enabled',
    };
  }, [agent, relayEnabled, pulseEnabled]);
}
