import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { permissionKeys } from './permission-keys';

/**
 * The level an agent actually runs at: what a new chat of it starts at before
 * any per-chat limit, and whether a person's setting holds it there.
 *
 * @param agentId - The agent's id; the query waits until one is known.
 * @returns The TanStack Query result for `GET /api/agents/:id/level`.
 */
export function useAgentLevel(agentId: string | undefined) {
  const transport = useTransport();
  return useQuery({
    queryKey: permissionKeys.level(agentId ?? ''),
    queryFn: () => transport.getAgentLevel(agentId!),
    enabled: Boolean(agentId),
  });
}
