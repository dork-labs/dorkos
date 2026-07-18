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
import {
  asMarketplaceCategory,
  CATEGORY_LABELS,
  primaryCategory,
  type MergedMarketplaceEntry,
} from '@dorkos/marketplace';

interface PackageCardProps {
  package: MergedMarketplaceEntry;
  installCount?: number;
}

/**
 * Render a marketplace package card linking to its detail page.
 *
 * The whole card links to `/marketplace/[name]` via a stretched overlay link,
 * so the primary category can render as its own independent `<Link>` chip
 * (pointing at the category landing page) without nesting anchors. The chip is
 * only a link when the primary category is a controlled slug — legacy
 * free-string categories render as plain text so no link 404s before the
 * registry backfill lands.
 *
 * @param props.package - The merged marketplace entry (CC fields + DorkOS extensions)
 * @param props.installCount - Optional install count from telemetry
 */
export function PackageCard({ package: pkg, installCount }: PackageCardProps) {
  const icon = pkg.dorkos?.icon ?? '📦';
  const kind = pkg.dorkos?.type ?? 'plugin';
  const primary = primaryCategory(pkg.dorkos?.categories, pkg.category);
  const knownCategory = primary ? asMarketplaceCategory(primary) : undefined;

  return (
    <div className="border-warm-gray-light/30 hover:border-charcoal/40 group relative rounded-lg border p-5 transition-colors">
      {/* Stretched overlay link — the whole card navigates to the detail page. */}
      <Link
        href={`/marketplace/${pkg.name}`}
        aria-label={pkg.name}
        className="absolute inset-0 z-0 rounded-lg"
      />
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
        {knownCategory ? (
          <Link
            href={`/marketplace/category/${knownCategory}`}
            className="text-warm-gray-light hover:text-charcoal relative z-10 text-xs underline-offset-2 transition-colors hover:underline"
          >
            {CATEGORY_LABELS[knownCategory]}
          </Link>
        ) : primary ? (
          <span className="text-warm-gray-light text-xs">{primary}</span>
        ) : (
          <span />
        )}
        {installCount !== undefined && installCount > 0 && (
          <span className="text-warm-gray-light relative z-10 text-xs">
            {installCount.toLocaleString()} installs
          </span>
        )}
      </div>
    </div>
  );
}
