/**
 * PackageCard — compact card for a single marketplace package.
 *
 * Used in the main browse grid and the featured agents rail. Pure server
 * component (no `'use client'`). Mirrors the visual idiom of
 * `apps/site/src/layers/features/marketing/ui/FeatureCard.tsx`.
 *
 * @module features/marketplace/ui/PackageCard
 */

import Link from 'next/link';
import type { MergedMarketplaceEntry } from '@dorkos/marketplace';

interface PackageCardProps {
  package: MergedMarketplaceEntry;
  installCount?: number;
}

/**
 * Render a marketplace package card linking to its detail page.
 *
 * @param props.package - The merged marketplace entry (CC fields + DorkOS extensions)
 * @param props.installCount - Optional install count from telemetry
 */
export function PackageCard({ package: pkg, installCount }: PackageCardProps) {
  const icon = pkg.dorkos?.icon ?? '📦';
  const kind = pkg.dorkos?.type ?? 'plugin';
  return (
    <Link
      href={`/marketplace/${pkg.name}`}
      className="border-warm-gray-light/30 hover:border-charcoal/40 group block rounded-lg border p-5 transition-colors"
    >
      <div className="mb-3 flex items-center gap-3">
        <span className="text-3xl" aria-hidden>
          {icon}
        </span>
        <div className="flex-1">
          <h3 className="text-charcoal font-mono text-base font-semibold">{pkg.name}</h3>
          <p className="text-warm-gray-light font-mono text-xs tracking-wider uppercase">{kind}</p>
        </div>
      </div>
      {pkg.description && (
        <p className="text-warm-gray line-clamp-3 text-sm leading-relaxed">{pkg.description}</p>
      )}
      <div className="mt-4 flex items-center justify-between">
        {pkg.category && <span className="text-warm-gray-light text-xs">{pkg.category}</span>}
        {installCount !== undefined && installCount > 0 && (
          <span className="text-warm-gray-light text-xs">
            {installCount.toLocaleString()} installs
          </span>
        )}
      </div>
    </Link>
  );
}
