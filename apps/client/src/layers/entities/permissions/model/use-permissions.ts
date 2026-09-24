import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { permissionKeys } from './permission-keys';

/**
 * What agents may do by default: the preset, the changes on top of it, every
 * area with its actions, and the agents set differently.
 *
 * @returns The TanStack Query result for `GET /api/permissions`.
 */
export function usePermissions() {
  const transport = useTransport();
  return useQuery({
    queryKey: permissionKeys.overview(),
    queryFn: () => transport.getPermissions(),
  });
}
