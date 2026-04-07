/**
 * InstallInstructions — server-rendered install command block for the
 * marketplace package detail page.
 *
 * Renders the canonical `dorkos install <name>` command for a package and a
 * pointer to the in-app catalog. Pure server component — no `'use client'`,
 * no client-side interactivity.
 *
 * @module features/marketplace/ui/InstallInstructions
 */

import type { MergedMarketplaceEntry } from '@dorkos/marketplace';

interface InstallInstructionsProps {
  package: MergedMarketplaceEntry;
}

/**
 * Render the install command and a pointer to the in-app marketplace catalog.
 *
 * @param props.package - The marketplace.json entry to install
 */
export function InstallInstructions({ package: pkg }: InstallInstructionsProps) {
  return (
    <section className="mb-10">
      <h2 className="text-charcoal mb-3 font-mono text-sm tracking-wider uppercase">Install</h2>
      <pre className="bg-charcoal text-cream-primary overflow-x-auto rounded-lg p-4 text-sm">
        <code>dorkos install {pkg.name}</code>
      </pre>
      <p className="text-warm-gray-light mt-3 text-sm">
        Or browse the catalog inside DorkOS at <code>/marketplace</code>.
      </p>
    </section>
  );
}
