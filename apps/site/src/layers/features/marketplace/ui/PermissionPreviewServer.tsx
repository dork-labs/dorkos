/**
 * PermissionPreviewServer — server-rendered permission preview for the
 * marketplace package detail page.
 *
 * Renders the high-level permission claims derived from a package's
 * `marketplace.json` entry. This is the lightweight preview that appears on
 * `/marketplace/[slug]`; the full permission preview (with external network
 * hosts and other deep-introspection details) is shown only at install time
 * inside the DorkOS client.
 *
 * Pure server component — no client-side interactivity, no `'use client'`.
 *
 * @module features/marketplace/ui/PermissionPreviewServer
 */

import type { MergedMarketplaceEntry } from '@dorkos/marketplace';
import { formatPermissions } from '../lib/format-permissions';

interface PermissionPreviewServerProps {
  package: MergedMarketplaceEntry;
}

/**
 * Render the high-level permission claims for a marketplace package.
 *
 * @param props.package - The marketplace.json entry to summarize
 */
export function PermissionPreviewServer({ package: pkg }: PermissionPreviewServerProps) {
  const claims = formatPermissions(pkg);

  return (
    <section className="border-warm-gray-light/30 mb-10 rounded-lg border p-5">
      <h2 className="text-charcoal mb-3 font-mono text-sm tracking-wider uppercase">
        What this package does
      </h2>
      <ul className="space-y-2">
        {claims.map((claim) => (
          <li key={claim.label} className="flex items-start gap-3">
            <span
              className={claim.level === 'warn' ? 'text-amber-600' : 'text-warm-gray'}
              aria-hidden
            >
              {claim.level === 'warn' ? '⚠' : '✓'}
            </span>
            <div>
              <p className="text-charcoal text-sm font-medium">{claim.label}</p>
              <p className="text-warm-gray-light text-xs">{claim.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-warm-gray-light mt-4 text-xs">
        The full permission preview, including external network hosts, is shown when you confirm
        install in DorkOS.
      </p>
    </section>
  );
}
