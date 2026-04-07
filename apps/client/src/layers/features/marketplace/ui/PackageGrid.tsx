import { useMemo } from 'react';
import { useMarketplacePackages, useInstalledPackages } from '@/layers/entities/marketplace';
import { useDorkHubStore } from '../model/dork-hub-store';
import { filterPackages } from '../lib/package-filter';
import { sortPackages } from '../lib/package-sort';
import { PackageCard } from './PackageCard';
import { PackageLoadingSkeleton } from './PackageLoadingSkeleton';
import { PackageEmptyState } from './PackageEmptyState';
import { PackageErrorState } from './PackageErrorState';

/**
 * Main browse grid for Dork Hub.
 *
 * Fetches the full package catalog via `useMarketplacePackages`, applies the
 * active filters and sort order from `useDorkHubStore`, and delegates rendering
 * to one of three state components (loading, error, empty) or the card grid.
 *
 * Installed package names are derived from `useInstalledPackages` and passed
 * as a `Set<string>` so each `PackageCard` can show its installed state without
 * an O(n²) scan per render.
 */
export function PackageGrid() {
  const { data, isLoading, error, refetch } = useMarketplacePackages();
  const { data: installed } = useInstalledPackages();

  const filters = useDorkHubStore((s) => s.filters);
  const resetFilters = useDorkHubStore((s) => s.resetFilters);
  const openDetail = useDorkHubStore((s) => s.openDetail);
  const openInstallConfirm = useDorkHubStore((s) => s.openInstallConfirm);

  const visible = useMemo(() => {
    if (!data) return [];
    return sortPackages(filterPackages(data, filters), filters.sort);
  }, [data, filters]);

  const installedNames = useMemo(() => new Set((installed ?? []).map((p) => p.name)), [installed]);

  if (isLoading) return <PackageLoadingSkeleton />;
  if (error) return <PackageErrorState error={error as Error} onRetry={() => void refetch()} />;
  if (visible.length === 0) return <PackageEmptyState onResetFilters={resetFilters} />;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
      {visible.map((pkg) => (
        <PackageCard
          key={pkg.name}
          pkg={pkg}
          installed={installedNames.has(pkg.name)}
          onClick={() => openDetail(pkg)}
          onInstallClick={() => openInstallConfirm(pkg)}
        />
      ))}
    </div>
  );
}
