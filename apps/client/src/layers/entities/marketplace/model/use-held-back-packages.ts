import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { HeldBackPackage } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/**
 * Every global package held back from sessions, with what it runs and what a
 * decision binds (DOR-2306). Read only when asked for (`enabled`), because it
 * hashes any package installed before hashes were recorded.
 *
 * @param enabled - Whether to read it now.
 */
export function useHeldBackPackages(enabled: boolean) {
  const transport = useTransport();
  return useQuery<HeldBackPackage[]>({
    queryKey: marketplaceKeys.heldBack(),
    queryFn: () => transport.listHeldBackPackages(),
    enabled,
  });
}
