import { useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useMarketplacePackages, useInstalledPackages } from '@/layers/entities/marketplace';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/layers/shared/ui';
import { useDorkHubStore, type DorkHubSort } from '../model/dork-hub-store';
import { filterPackages } from '../lib/package-filter';
import { sortPackages } from '../lib/package-sort';
import { PackageCard } from './PackageCard';
import { PackageLoadingSkeleton } from './PackageLoadingSkeleton';
import { PackageEmptyState } from './PackageEmptyState';
import { PackageErrorState } from './PackageErrorState';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SORT_OPTIONS: ReadonlyArray<{ value: DorkHubSort; label: string }> = [
  { value: 'featured', label: 'Featured' },
  { value: 'name', label: 'A–Z' },
  { value: 'recent', label: 'Recent' },
  { value: 'popular', label: 'Popular' },
];

/** Cap stagger to avoid slow entry on large catalogs. */
const MAX_STAGGER_ITEMS = 20;
const STAGGER_DELAY = 0.03;

// ---------------------------------------------------------------------------
// Motion variants
// ---------------------------------------------------------------------------

const gridVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: STAGGER_DELAY },
  },
} as const;

const cardVariants = {
  hidden: (i: number) => ({
    opacity: i < MAX_STAGGER_ITEMS ? 0 : 1,
    y: i < MAX_STAGGER_ITEMS ? 12 : 0,
  }),
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.25, ease: 'easeOut' as const },
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Main browse grid for Dork Hub.
 *
 * Fetches the full package catalog via `useMarketplacePackages`, applies the
 * active filters and sort order from `useDorkHubStore`, and delegates rendering
 * to one of three state components (loading, error, empty) or the card grid.
 */
export function PackageGrid() {
  const { data, isLoading, error, refetch } = useMarketplacePackages();
  const { data: installed } = useInstalledPackages();
  const prefersReducedMotion = useReducedMotion();

  const filters = useDorkHubStore((s) => s.filters);
  const setSort = useDorkHubStore((s) => s.setSort);
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
    <div className="space-y-4">
      {/* Section header with count + sort */}
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">
          All Packages
          <span className="text-muted-foreground ml-2 text-sm font-normal">({visible.length})</span>
        </h2>
        <Select value={filters.sort} onValueChange={(v) => setSort(v as DorkHubSort)}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Animated card grid */}
      <motion.div
        variants={prefersReducedMotion ? undefined : gridVariants}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
      >
        {visible.map((pkg, index) => (
          <motion.div
            key={pkg.name}
            variants={prefersReducedMotion ? undefined : cardVariants}
            custom={index < MAX_STAGGER_ITEMS ? index : 0}
            className="h-full"
          >
            <PackageCard
              pkg={pkg}
              installed={installedNames.has(pkg.name)}
              onClick={() => openDetail(pkg)}
              onInstallClick={() => openInstallConfirm(pkg)}
            />
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
