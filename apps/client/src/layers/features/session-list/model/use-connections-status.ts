import { useMemo } from 'react';
import { useAgentToolStatus } from '@/layers/entities/agent';
import { useRelayAdapters } from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';

/** Aggregate connection status for the Connections tab badge dot. */
export type ConnectionsStatus = 'ok' | 'partial' | 'error' | 'none';

/**
 * Derive aggregate connection status for the Connections tab badge.
 *
 * Piggybacks on existing TanStack Query caches from `useRelayAdapters` (10s poll)
 * and `useRegisteredAgents` (30s stale time) — no additional API calls are made.
 *
 * Status derivation rules:
 * - `none`: no adapters and no agents registered
 * - `error`: any adapter has `status.state === 'error'`
 * - `ok`: all adapters are connected (or there are no adapters) with agents present or absent
 * - `partial`: some adapters are not connected (disconnected, starting, or stopping)
 *
 * @param projectPath - Working directory path for per-agent tool status resolution.
 * @returns Aggregate status: 'ok', 'partial', 'error', or 'none'.
 */
export function useConnectionsStatus(projectPath: string | null): ConnectionsStatus {
  const toolStatus = useAgentToolStatus(projectPath);
  const relayEnabled = toolStatus.relay !== 'disabled-by-server';
  const meshEnabled = toolStatus.mesh !== 'disabled-by-server';
  const { data: adapters } = useRelayAdapters(relayEnabled);
  const { data: agentsData } = useRegisteredAgents(undefined, meshEnabled);
  const agents = agentsData?.agents;

  return useMemo(() => {
    const adapterList = adapters ?? [];
    const agentList = agents ?? [];

    if (adapterList.length === 0 && agentList.length === 0) return 'none';

    // Any adapter in an error state surfaces immediately.
    if (adapterList.some((a) => a.status.state === 'error')) return 'error';

    // All adapters must be in the connected state for a fully healthy status.
    // AgentManifest has no runtime status — presence in the registry is treated as available.
    if (adapterList.every((a) => a.status.state === 'connected')) return 'ok';

    return 'partial';
  }, [adapters, agents]);
}
