/**
 * MarketplaceGrid — server-rendered package grid for the /marketplace page.
 *
 * Renders a type filter strip (pure `<Link>` elements, no JS) plus a 1/2/3
 * column responsive grid of `PackageCard`. Mirrors the `ProductTab` filter
 * pattern from `apps/site/src/app/(marketing)/features/page.tsx`.
 *
 * @module features/marketplace/ui/MarketplaceGrid
 */

import Link from 'next/link';
import type { RankedPackage } from '../lib/ranking';
import { PackageCard } from './PackageCard';

const PACKAGE_TYPES = ['agent', 'plugin', 'skill-pack', 'adapter'] as const;

interface MarketplaceGridProps {
  packages: RankedPackage[];
  installCounts: Record<string, number>;
  initialFilters: { type?: string; category?: string; q?: string };
}

/**
 * Render the marketplace browse grid with a filter strip and package cards.
 *
 * @param props.packages - Pre-ranked packages to render
 * @param props.installCounts - Map of package name to install count
 * @param props.initialFilters - Active filters from the page query string
 */
export function MarketplaceGrid({ packages, installCounts, initialFilters }: MarketplaceGridProps) {
  return (
    <section>
      <nav className="mb-8 flex flex-wrap gap-2" aria-label="Filter by package type">
        <FilterTab href="/marketplace" active={!initialFilters.type} label="All" />
        {PACKAGE_TYPES.map((type) => (
          <FilterTab
            key={type}
            href={`/marketplace?type=${type}`}
            active={initialFilters.type === type}
            label={type}
          />
        ))}
      </nav>
      {packages.length === 0 ? (
        <p className="text-warm-gray-light text-sm">No packages match these filters.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {packages.map((pkg) => (
            <PackageCard key={pkg.name} package={pkg} installCount={installCounts[pkg.name]} />
          ))}
        </div>
      )}
    </section>
  );
}

function FilterTab({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-4 py-1.5 font-mono text-xs tracking-[0.04em] transition-colors ${
        active
          ? 'bg-charcoal text-cream-primary'
          : 'border-warm-gray-light/30 text-warm-gray hover:text-charcoal border'
      }`}
    >
      {label}
    </Link>
  );
}
