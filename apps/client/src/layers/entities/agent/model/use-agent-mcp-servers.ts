import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ManagedMcpServerView } from '@dorkos/shared/mesh-schemas';
import { agentKeys } from '../api/queries';

/**
 * Read an agent's DorkOS-managed MCP servers (the `mcp.list` capability).
 *
 * Each entry carries its stored config plus a derived `authStatus` — whether
 * DorkOS holds a live sign-in for a remote server — which is available without
 * waiting for an agent turn. Join with `useMcpConfig` live status by server
 * `name` for the runtime's connection state and tool count. Skips the request
 * when `agentId` is nullish.
 *
 * @param agentId - ULID of the agent whose managed servers to read, or null to skip.
 */
export function useAgentMcpServers(agentId: string | null | undefined) {
  const transport = useTransport();
  return useQuery<ManagedMcpServerView[]>({
    queryKey: agentKeys.mcpServers(agentId ?? ''),
    queryFn: () => transport.listAgentMcpServers(agentId!),
    enabled: !!agentId,
    staleTime: 30_000,
  });
}
