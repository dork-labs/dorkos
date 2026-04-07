/**
 * Format a marketplace.json entry into a high-level permission preview.
 *
 * Reads only metadata declared in marketplace.json (type, layers, tags) and
 * produces a list of human-readable permission claims for display on the
 * /marketplace/[slug] page.
 *
 * NOTE: Unlike the install-time permission preview in spec 02, this does NOT
 * clone the package or read the full manifest. It is intentionally
 * conservative — it shows what the marketplace entry CLAIMS the package will
 * do, with a footer linking to the full preview that is shown at install time.
 *
 * @module features/marketplace/lib/format-permissions
 */

import type { MergedMarketplaceEntry } from '@dorkos/marketplace';

/** A formatted permission claim ready for display. */
export interface PermissionClaim {
  /** Short label, e.g. "Adds skill files". */
  label: string;
  /** Longer explanation. */
  detail: string;
  /** Severity bucket for visual treatment. */
  level: 'info' | 'warn';
}

const LAYER_LABELS: Record<string, string> = {
  skills: 'Adds skill files',
  tasks: 'Schedules background tasks',
  commands: 'Adds slash commands',
  hooks: 'Installs lifecycle hooks',
  extensions: 'Installs UI extensions',
  adapters: 'Installs messaging adapters',
  'mcp-servers': 'Adds MCP servers',
  'lsp-servers': 'Adds LSP servers',
  agents: 'Adds agent definitions',
};

/**
 * Format a package's declared layers into a list of permission claims.
 *
 * Each claim corresponds to a layer the package declares it will install.
 * Layers `hooks` and `mcp-servers` are flagged as `warn` because they can
 * execute arbitrary code at runtime; everything else is `info`.
 *
 * When the package declares no layers (or only unknown layer values), a
 * single sentinel claim is returned so the UI never renders an empty list.
 *
 * @param pkg - The marketplace.json entry whose permissions should be formatted
 * @returns Array of permission claims, always non-empty
 */
export function formatPermissions(pkg: MergedMarketplaceEntry): PermissionClaim[] {
  const claims: PermissionClaim[] = [];
  const layers = pkg.dorkos?.layers ?? [];

  for (const layer of layers) {
    const label = LAYER_LABELS[layer];
    if (!label) continue;
    claims.push({
      label,
      detail: `Files will be staged under .dork/marketplaces/dorkos/${pkg.name}/`,
      level: layer === 'hooks' || layer === 'mcp-servers' ? 'warn' : 'info',
    });
  }

  if (claims.length === 0) {
    claims.push({
      label: 'No declared permissions',
      detail:
        'This package has not declared what it modifies. The full preview is shown at install time.',
      level: 'info',
    });
  }

  return claims;
}
