/**
 * PackageHeader — server-rendered header for the marketplace package detail page.
 *
 * Renders the package icon, name, type/category line, description, install
 * count (when known and non-zero), and a link to the source repository. Pure
 * server component — no `'use client'`, no client-side interactivity.
 *
 * @module features/marketplace/ui/PackageHeader
 */

import type { MarketplaceJsonEntry } from '@dorkos/marketplace';

interface PackageHeaderProps {
  package: MarketplaceJsonEntry;
  installCount: number;
}

/**
 * Render the header section for a marketplace package detail page.
 *
 * @param props.package - The marketplace.json entry to display
 * @param props.installCount - Total install count for this package; values
 *   less than or equal to zero hide the install-count line entirely
 */
export function PackageHeader({ package: pkg, installCount }: PackageHeaderProps) {
  const type = pkg.type ?? 'plugin';
  return (
    <header className="mb-10">
      <div className="mb-4 flex items-center gap-4">
        <span className="text-6xl" aria-hidden>
          {pkg.icon ?? '📦'}
        </span>
        <div>
          <h1 className="text-charcoal font-mono text-3xl font-bold">{pkg.name}</h1>
          <p className="text-warm-gray-light mt-1 font-mono text-xs tracking-wider uppercase">
            {pkg.category ? `${type} · ${pkg.category}` : type}
          </p>
        </div>
      </div>
      {pkg.description && <p className="text-warm-gray text-lg">{pkg.description}</p>}
      <div className="text-warm-gray-light mt-4 flex items-center gap-4 text-sm">
        {installCount > 0 && <span>{installCount.toLocaleString()} installs</span>}
        <a href={pkg.source} className="underline" target="_blank" rel="noopener noreferrer">
          Source
        </a>
      </div>
    </header>
  );
}
