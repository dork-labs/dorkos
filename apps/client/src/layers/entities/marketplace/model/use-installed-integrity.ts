import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { InstallIntegrity } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/**
 * Whether each installation's files still match what was installed (DOR-2197),
 * for every scope the Installed view lists, keyed by `installPath`.
 *
 * One request for the whole view, never one per row. Verifying reads every
 * shipped file, so it is its own query beside the plain installed list: the
 * list renders at once, and each row's note appears when this lands.
 */
export function useInstalledIntegrity() {
  const transport = useTransport();
  return useQuery({
    queryKey: marketplaceKeys.integrity(),
    queryFn: () => transport.listInstalledPackages(undefined, { verify: true }),
    select: (packages): Map<string, InstallIntegrity> =>
      new Map(
        packages.flatMap((pkg) =>
          pkg.integrity ? [[pkg.installPath, pkg.integrity] as const] : []
        )
      ),
    staleTime: 60_000,
  });
}
