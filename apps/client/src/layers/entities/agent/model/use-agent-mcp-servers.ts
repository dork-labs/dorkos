import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ManagedMcpServer } from '@dorkos/shared/mesh-schemas';
import { agentKeys } from '../api/queries';

/**
 * Read an agent's DorkOS-managed MCP servers (the `mcp.list` capability).
 *
 * Config only — the enabled state and connection each entry declares. Join it
 * with `useMcpConfig` live status by server `name` for the connection state and
 * tool count. Skips the request when `agentId` is nullish.
 *
 * @param agentId - ULID of the agent whose managed servers to read, or null to skip.
 */
export function useAgentMcpServers(agentId: string | null | undefined) {
  const transport = useTransport();
  return useQuery<ManagedMcpServer[]>({
    queryKey: agentKeys.mcpServers(agentId ?? ''),
    queryFn: () => transport.listAgentMcpServers(agentId!),
    enabled: !!agentId,
    staleTime: 30_000,
  });
}
