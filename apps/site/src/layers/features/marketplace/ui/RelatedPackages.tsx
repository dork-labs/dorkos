/**
 * RelatedPackages — server-rendered "more like this" section for the
 * marketplace package detail page.
 *
 * Picks up to three packages of the same `type` as the current package
 * (excluding the current one) and renders them with `PackageCard`. Returns
 * `null` if the current package can't be found in the registry or no
 * same-type peers exist, so the section disappears cleanly when empty.
 *
 * Pure server component — no `'use client'`, no client-side interactivity.
 *
 * @module features/marketplace/ui/RelatedPackages
 */

import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import { PackageCard } from './PackageCard';

const MAX_RELATED = 3;

interface RelatedPackagesProps {
  /** Name of the package being shown on the current detail page. */
  currentName: string;
  /** Full marketplace registry to pick related packages from. */
  allPackages: MarketplaceJsonEntry[];
  /** Map of package name to install count, used by the rendered cards. */
  installCounts: Record<string, number>;
}

/**
 * Render up to {@link MAX_RELATED} same-type packages excluding the current one.
 */
export function RelatedPackages({ currentName, allPackages, installCounts }: RelatedPackagesProps) {
  const current = allPackages.find((p) => p.name === currentName);
  if (!current) return null;

  const related = allPackages
    .filter((p) => p.name !== currentName && p.type === current.type)
    .slice(0, MAX_RELATED);

  if (related.length === 0) return null;

  return (
    <section className="mt-12">
      <h2 className="text-charcoal mb-4 font-mono text-sm tracking-wider uppercase">
        More like this
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {related.map((p) => (
          <PackageCard key={p.name} package={p} installCount={installCounts[p.name]} />
        ))}
      </div>
    </section>
  );
}
