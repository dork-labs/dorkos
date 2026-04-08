/**
 * @dorkos/marketplace — Merge a CC marketplace document with its DorkOS sidecar.
 *
 * This module is the single source of truth for joining a parsed
 * `marketplace.json` (CC-standard) with a parsed `dorkos.json` (DorkOS
 * sidecar). Every consumer — server install pipeline, site fetch layer,
 * client UI, CLI validators — reads merged entries rather than
 * hand-joining the two documents.
 *
 * Browser-safe — no Node.js dependencies.
 *
 * @module @dorkos/marketplace/merge-marketplace
 */

import type { MarketplaceJson, MarketplaceJsonEntry } from './marketplace-json-schema.js';
import type { DorkosSidecar, DorkosEntry } from './dorkos-sidecar-schema.js';

/**
 * A merged plugin entry combining CC-standard fields with optional DorkOS
 * extensions. When the sidecar is absent or does not contain an entry for
 * this plugin, `dorkos` is `undefined` and consumers should treat the
 * plugin as a default `plugin` type with no extensions.
 */
export interface MergedMarketplaceEntry extends MarketplaceJsonEntry {
  /** DorkOS-specific extensions from the sidecar. Undefined if not present. */
  dorkos?: DorkosEntry;
}

/**
 * Result of merging `marketplace.json` and `dorkos.json`. Orphan entries
 * (sidecar plugins with no matching marketplace entry) are returned by name
 * so callers can log warnings with their own logger.
 */
export interface MergeMarketplaceResult {
  entries: MergedMarketplaceEntry[];
  /** Plugin names that appeared in the sidecar but not in marketplace.json. */
  orphans: string[];
}

/**
 * Merge a parsed `marketplace.json` with an optional parsed `dorkos.json`
 * sidecar into a keyed array of merged entries plus an orphan list.
 *
 * **Drift handling rules:**
 *
 * 1. Plugin in `marketplace.json` but not in `dorkos.json` → merged entry
 *    has `dorkos: undefined`. Treated as a default plugin (type inferred
 *    as `plugin`, no layers, pricing implicit `free`). Not an error.
 * 2. Plugin in `dorkos.json` but not in `marketplace.json` → name added to
 *    `orphans` array. Caller is expected to log a warning. Orphan is
 *    silently dropped from merged output. Not an error.
 *
 * This function does not log warnings itself — it returns the orphan list
 * so callers can use their own logger (`@dorkos/shared/logger` on the
 * server, `console.warn` on the site, etc.).
 *
 * @param cc - Parsed `marketplace.json` document.
 * @param sidecar - Parsed `dorkos.json` sidecar, or `null` if absent.
 * @returns Merged entries and orphan plugin names.
 */
export function mergeMarketplace(
  cc: MarketplaceJson,
  sidecar: DorkosSidecar | null
): MergeMarketplaceResult {
  const entries: MergedMarketplaceEntry[] = cc.plugins.map((entry) => ({
    ...entry,
    dorkos: sidecar?.plugins[entry.name],
  }));

  const orphans: string[] = [];
  if (sidecar) {
    const ccNames = new Set(cc.plugins.map((p) => p.name));
    for (const sidecarName of Object.keys(sidecar.plugins)) {
      if (!ccNames.has(sidecarName)) {
        orphans.push(sidecarName);
      }
    }
  }

  return { entries, orphans };
}
