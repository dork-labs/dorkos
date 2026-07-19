import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { Skeleton } from '@/layers/shared/ui';
import { useMarketplaceStore } from '../model/marketplace-store';
import { useMarketplaceParams } from '../model/use-marketplace-params';
import { PackageCard } from './PackageCard';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of items displayed in the rail. */
const MAX_RAIL_ITEMS = 3;

/** Number of skeleton placeholders shown while data is loading. */
const SKELETON_COUNT = 3;

/** Heading shown above the rail. */
const RAIL_LABEL = 'Featured';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Loading skeleton row shown while packages are being fetched. */
function RailSkeleton() {
  return (
    <section aria-label={RAIL_LABEL} className="space-y-3">
      <h2 className="text-base font-semibold">{RAIL_LABEL}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-xl" />
        ))}
      </div>
    </section>
  );
}

/** Responsive grid rail of package cards. */
function RailGrid({
  packages,
}: {
  packages: import('@dorkos/shared/marketplace-schemas').AggregatedPackage[];
}) {
  const { openDetail } = useMarketplaceParams();
  const openInstallConfirm = useMarketplaceStore((s) => s.openInstallConfirm);

  return (
    <section aria-label={RAIL_LABEL} className="space-y-3">
      <h2 className="text-base font-semibold">{RAIL_LABEL}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {packages.map((pkg) => (
          <div key={pkg.name} className="h-full">
            <PackageCard
              pkg={pkg}
              onClick={() => openDetail(pkg.name)}
              onInstallClick={() => openInstallConfirm(pkg)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Hero rail at the top of Marketplace.
 *
 * Highlights every package flagged `featured: true` — of any type (agents,
 * plugins, skill packs, adapters, shapes) — capped at {@link MAX_RAIL_ITEMS}.
 * The cards carry their own type badges, so a mixed rail reads clearly. When
 * nothing is featured the rail renders nothing at all.
 *
 * The rail is a browse affordance, so it hides with a smooth transition the
 * moment the user narrows the catalog — any active search text, type filter, or
 * category filter collapses it, keeping the full result set in view.
 */
export function FeaturedRail() {
  // One unfiltered catalog fetch, shared (via TanStack Query cache) with the
  // grid below. Featured selection happens client-side.
  const { data, isLoading } = useMarketplacePackages();
  const prefersReducedMotion = useReducedMotion();

  // Hide the rail whenever the user narrows the catalog by any axis.
  const { search, type, category } = useMarketplaceParams();
  const hasActiveFilters = search.length > 0 || type !== 'all' || category !== null;

  // Determine the content to render (or null if nothing to show).
  let railContent: React.ReactNode = null;

  if (hasActiveFilters) {
    railContent = null;
  } else if (isLoading) {
    railContent = <RailSkeleton />;
  } else {
    const featured = (data ?? []).filter((p) => p.featured).slice(0, MAX_RAIL_ITEMS);
    if (featured.length > 0) {
      railContent = <RailGrid packages={featured} />;
    }
  }

  return (
    <AnimatePresence initial={false}>
      {railContent && (
        <motion.div
          key="featured-rail"
          initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={
            prefersReducedMotion
              ? undefined
              : { opacity: 0, height: 0, transition: { duration: 0.25, ease: 'easeInOut' } }
          }
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="overflow-hidden"
        >
          {railContent}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
