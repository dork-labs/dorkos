/**
 * Read the installed Shapes (`GET /api/shapes`), each tagged with its active
 * flag and fork lineage. Server state via TanStack Query.
 *
 * @module entities/shapes/model/use-shapes
 */
import { useQuery } from '@tanstack/react-query';
import type { InstalledShapeSummary } from '@dorkos/shared/marketplace-schemas';
import { useTransport } from '@/layers/shared/model';
import { shapeKeys } from '../api/query-keys';

/**
 * Fetch the installed Shapes. Treated as fairly static (a Shape is installed
 * from the marketplace, not minute-to-minute), so a 30s stale window keeps the
 * switcher snappy without hammering the endpoint.
 */
export function useShapes() {
  const transport = useTransport();
  return useQuery<InstalledShapeSummary[]>({
    queryKey: shapeKeys.list(),
    queryFn: () => transport.listShapes(),
    staleTime: 30_000,
  });
}
