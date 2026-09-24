import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { permissionKeys } from './permission-keys';

/**
 * One agent's permissions: its resolved state per area and action, where each
 * came from, and what it would inherit.
 *
 * @param agentId - The agent's id; the query waits until one is known.
 * @returns The TanStack Query result for `GET /api/agents/:id/permissions`.
 */
export function useAgentPermissions(agentId: string | undefined) {
  const transport = useTransport();
  return useQuery({
    queryKey: permissionKeys.agent(agentId ?? ''),
    queryFn: () => transport.getAgentPermissions(agentId!),
    enabled: Boolean(agentId),
  });
}
