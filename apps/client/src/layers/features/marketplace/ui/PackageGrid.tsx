import { useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { asMarketplaceCategory, CATEGORY_LABELS } from '@dorkos/marketplace';
import { useMarketplacePackages, useInstalledPackages } from '@/layers/entities/marketplace';
import { useRequestInstall } from '../model/use-request-install';
import { useMarketplaceParams } from '../model/use-marketplace-params';
import { filterPackages } from '../lib/package-filter';
import { sortPackages } from '../lib/package-sort';
import { PackageCard } from './PackageCard';
import { PackageLoadingSkeleton } from './PackageLoadingSkeleton';
import { PackageEmptyState } from './PackageEmptyState';
import { PackageErrorState } from './PackageErrorState';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
 * Main browse grid for Marketplace.
 *
 * Fetches the full package catalog via `useMarketplacePackages`, applies the
 * active filters and sort order from the URL (`useMarketplaceParams`), and
 * delegates rendering to one of three state components (loading, error, empty)
 * or the card grid.
 */
export function PackageGrid() {
  const { data, isLoading, error, refetch } = useMarketplacePackages();
  const { data: installed } = useInstalledPackages();
  const prefersReducedMotion = useReducedMotion();

  const { type, categories, search, sort, resetFilters, clearCategories, openDetail } =
    useMarketplaceParams();
  const requestInstall = useRequestInstall();

  const visible = useMemo(() => {
    if (!data) return [];
    return sortPackages(filterPackages(data, { type, categories, search }), sort);
  }, [data, type, categories, search, sort]);

  const installedNames = useMemo(() => new Set((installed ?? []).map((p) => p.name)), [installed]);

  if (isLoading) return <PackageLoadingSkeleton />;
  if (error) return <PackageErrorState error={error as Error} onRetry={() => void refetch()} />;
  if (visible.length === 0) {
    // A category filter with no matches gets a category-aware message and a
    // single "Clear categories" affordance rather than the generic reset.
    if (categories.length > 0) {
      const only = categories.length === 1 ? categories[0] : null;
      const known = only ? asMarketplaceCategory(only) : undefined;
      const label = only ? (known ? CATEGORY_LABELS[known] : only) : null;
      return (
        <PackageEmptyState
          title={label ? `No packages in ${label} yet` : 'No packages in these categories yet'}
          description="No packages match the selected categories. Try another category or clear the filter."
          resetLabel={categories.length === 1 ? 'Clear category' : 'Clear categories'}
          onResetFilters={clearCategories}
        />
      );
    }
    return <PackageEmptyState onResetFilters={resetFilters} />;
  }

  return (
    <div className="space-y-4">
      {/* Section header with count (sort lives in the page header now) */}
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">
          All Packages
          <span className="text-muted-foreground ml-2 text-sm font-normal">({visible.length})</span>
        </h2>
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
              onClick={() => openDetail(pkg.name)}
              onInstallClick={() => requestInstall(pkg)}
            />
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
