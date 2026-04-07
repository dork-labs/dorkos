/**
 * MarketplaceHeader — static header for the /marketplace browse page.
 *
 * Renders the page title, tagline, and a link to the marketplace privacy
 * page. Pure server component (no `'use client'`).
 *
 * @module features/marketplace/ui/MarketplaceHeader
 */

import Link from 'next/link';

/**
 * Render the marketplace browse page header.
 */
export function MarketplaceHeader() {
  return (
    <header className="mb-12">
      <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">Marketplace</h1>
      <p className="text-warm-gray mt-3 max-w-2xl text-lg">
        Pre-built agents, plugins, and skill packs from the DorkOS community. Install with one
        command.
      </p>
      <p className="text-warm-gray-light mt-2 text-sm">
        Telemetry is opt-in.{' '}
        <Link href="/marketplace/privacy" className="underline">
          Read the privacy contract
        </Link>
        .
      </p>
    </header>
  );
}
