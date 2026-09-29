import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { permissionKeys } from './permission-keys';

/**
 * The permission history, newest first; with `agentId`, the changes that
 * touched that agent.
 *
 * @param agentId - Optional agent to narrow to.
 * @returns The TanStack Query result for `GET /api/permissions/history`.
 */
export function usePermissionHistory(agentId?: string) {
  const transport = useTransport();
  return useQuery({
    queryKey: permissionKeys.history(agentId),
    queryFn: () => transport.getPermissionHistory(agentId ? { agentId, limit: 50 } : { limit: 50 }),
  });
}
