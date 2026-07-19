/**
 * FeaturedRail — horizontal rail of featured marketplace packages.
 *
 * Sits above the main browse grid and surfaces curated picks across every
 * package type. Returns `null` (zero DOM) when there are no packages to
 * show — including when the caller hides it during an active filter/search
 * (see `MarketplacePage`, which passes an empty list in that case).
 *
 * @module features/marketplace/ui/FeaturedRail
 */

import type { RankedPackage } from '../lib/ranking';
import { PackageCard } from './PackageCard';

interface FeaturedRailProps {
  packages: RankedPackage[];
  installCounts: Record<string, number>;
}

/**
 * Render a featured-packages rail above the marketplace grid.
 *
 * @param props.packages - Featured packages, in display order
 * @param props.installCounts - Map of package name to install count
 */
export function FeaturedRail({ packages, installCounts }: FeaturedRailProps) {
  if (packages.length === 0) return null;

  return (
    <section className="mb-12">
      <h2 className="text-charcoal mb-4 font-mono text-sm tracking-wider uppercase">Featured</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {packages.map((pkg) => (
          <PackageCard key={pkg.name} package={pkg} installCount={installCounts[pkg.name]} />
        ))}
      </div>
    </section>
  );
}
