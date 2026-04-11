import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { Skeleton } from '@/layers/shared/ui';
import { useDorkHubStore } from '../model/dork-hub-store';
import { PackageCard } from './PackageCard';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of items displayed in the rail. */
const MAX_RAIL_ITEMS = 3;

/** Number of skeleton placeholders shown while data is loading. */
const SKELETON_COUNT = 3;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Loading skeleton row shown while packages are being fetched. */
function RailSkeleton({ label }: { label: string }) {
  return (
    <section aria-label={label} className="space-y-3">
      <h2 className="text-base font-semibold">{label}</h2>
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
  label,
  packages,
}: {
  label: string;
  packages: import('@dorkos/shared/marketplace-schemas').AggregatedPackage[];
}) {
  const openDetail = useDorkHubStore((s) => s.openDetail);
  const openInstallConfirm = useDorkHubStore((s) => s.openInstallConfirm);

  return (
    <section aria-label={label} className="space-y-3">
      <h2 className="text-base font-semibold">{label}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {packages.map((pkg) => (
          <div key={pkg.name} className="h-full">
            <PackageCard
              pkg={pkg}
              onClick={() => openDetail(pkg)}
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
 * Hero rail at the top of Dork Hub. Shows featured agents when available,
 * otherwise falls back to a "Popular Packages" selection from the full
 * catalog. Hides with a smooth transition when the user activates search
 * or type filters.
 */
export function FeaturedAgentsRail() {
  const { data: agentData, isLoading: agentLoading } = useMarketplacePackages({ type: 'agent' });
  const { data: allData, isLoading: allLoading } = useMarketplacePackages();
  const prefersReducedMotion = useReducedMotion();

  // Hide the rail when search or type filters are active.
  const search = useDorkHubStore((s) => s.filters.search);
  const typeFilter = useDorkHubStore((s) => s.filters.type);
  const hasActiveFilters = search.length > 0 || typeFilter !== 'all';

  const isLoading = agentLoading || allLoading;

  // Determine the content to render (or null if nothing to show).
  let railContent: React.ReactNode = null;

  if (isLoading && !hasActiveFilters) {
    railContent = <RailSkeleton label="Featured" />;
  } else if (!hasActiveFilters) {
    // Primary: featured agents.
    const featured = (agentData ?? []).filter((p) => p.featured).slice(0, MAX_RAIL_ITEMS);
    if (featured.length > 0) {
      railContent = <RailGrid label="Featured Agents" packages={featured} />;
    } else {
      // Fallback: pick a diverse set from the full catalog (first of each type).
      const allPackages = allData ?? [];
      if (allPackages.length > 0) {
        const seenTypes = new Set<string>();
        const diverse: typeof allPackages = [];
        for (const pkg of allPackages) {
          const type = pkg.type ?? 'plugin';
          if (!seenTypes.has(type)) {
            seenTypes.add(type);
            diverse.push(pkg);
          }
          if (diverse.length >= MAX_RAIL_ITEMS) break;
        }
        // Fill remaining slots if we ran out of unique types.
        if (diverse.length < MAX_RAIL_ITEMS) {
          for (const pkg of allPackages) {
            if (!diverse.some((d) => d.name === pkg.name)) {
              diverse.push(pkg);
            }
            if (diverse.length >= MAX_RAIL_ITEMS) break;
          }
        }
        railContent = (
          <RailGrid label="Popular Packages" packages={diverse.slice(0, MAX_RAIL_ITEMS)} />
        );
      }
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
