/**
 * PackageHeader — server-rendered header for the marketplace package detail page.
 *
 * Renders the package icon, name, type/category line, description, install
 * count (when known and non-zero), and a link to the source repository. Pure
 * server component — no `'use client'`, no client-side interactivity.
 *
 * @module features/marketplace/ui/PackageHeader
 */

import type { MergedMarketplaceEntry, PluginSource } from '@dorkos/marketplace';

interface PackageHeaderProps {
  package: MergedMarketplaceEntry;
  installCount: number;
}

/**
 * Render the header section for a marketplace package detail page.
 *
 * @param props.package - The merged marketplace entry (CC fields + DorkOS extensions)
 * @param props.installCount - Total install count for this package; values
 *   less than or equal to zero hide the install-count line entirely
 */
export function PackageHeader({ package: pkg, installCount }: PackageHeaderProps) {
  const type = pkg.dorkos?.type ?? 'plugin';
  const icon = pkg.dorkos?.icon ?? '📦';
  const sourceHref = pluginSourceToHref(pkg.source);
  return (
    <header className="mb-10">
      <div className="mb-4 flex items-center gap-4">
        <span className="text-6xl" aria-hidden>
          {icon}
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
        {sourceHref && (
          <a href={sourceHref} className="underline" target="_blank" rel="noopener noreferrer">
            Source
          </a>
        )}
      </div>
    </header>
  );
}

/**
 * Translate a discriminated `PluginSource` value into an external link URL
 * suitable for the "Source" button. Returns `null` for source forms that
 * don't map cleanly to a browser-navigable URL (relative-path, npm stub).
 */
function pluginSourceToHref(source: PluginSource): string | null {
  if (typeof source === 'string') {
    // Relative-path sources live inside the marketplace monorepo — there's
    // no single canonical URL to link to without knowing the marketplace
    // root, so omit the source link.
    return null;
  }
  switch (source.source) {
    case 'github':
      return `https://github.com/${source.repo}`;
    case 'url':
      return source.url.replace(/\.git$/, '');
    case 'git-subdir':
      return source.url.replace(/\.git$/, '');
    case 'npm':
      return `https://www.npmjs.com/package/${source.package}`;
  }
}
