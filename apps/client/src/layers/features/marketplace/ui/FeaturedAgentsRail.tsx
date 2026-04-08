import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { Skeleton } from '@/layers/shared/ui';
import { useDorkHubStore } from '../model/dork-hub-store';
import { PackageCard } from './PackageCard';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of featured agents displayed in the rail. */
const MAX_FEATURED = 6;

/** Number of skeleton placeholders shown while data is loading. */
const SKELETON_COUNT = 3;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Loading skeleton row shown while featured agents are being fetched. */
function FeaturedAgentsRailSkeleton() {
  return (
    <section aria-label="Featured agents" className="space-y-3">
      <h2 className="text-base font-semibold">Featured Agents</h2>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <Skeleton key={i} className="h-48 min-w-64 rounded-xl" />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * "Featured Agents" hero rail shown at the top of Dork Hub.
 *
 * Fetches agent packages from the marketplace (server-side `type: 'agent'`
 * filter), then narrows to those with `featured: true`, capping at
 * {@link MAX_FEATURED} entries. Returns `null` when there are no featured
 * agents, so no empty rail is mounted.
 *
 * Layout: horizontal scroll on mobile (`flex overflow-x-auto`), 2-column grid
 * on sm breakpoint, 3-column on md+.
 */
export function FeaturedAgentsRail() {
  const { data, isLoading } = useMarketplacePackages({ type: 'agent' });
  const openDetail = useDorkHubStore((s) => s.openDetail);
  const openInstallConfirm = useDorkHubStore((s) => s.openInstallConfirm);

  if (isLoading) {
    return <FeaturedAgentsRailSkeleton />;
  }

  // Server already filtered by type=agent; narrow further to featured entries.
  const featured = (data ?? []).filter((p) => p.featured).slice(0, MAX_FEATURED);

  if (featured.length === 0) {
    return null;
  }

  return (
    <section aria-label="Featured agents" className="space-y-3">
      <h2 className="text-base font-semibold">Featured Agents</h2>
      {/* Mobile: horizontal scroll row. sm+: 2-col grid. md+: 3-col grid. */}
      <div className="flex gap-4 overflow-x-auto pb-2 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0 md:grid-cols-3">
        {featured.map((pkg) => (
          <div key={pkg.name} className="min-w-64 sm:min-w-0">
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
