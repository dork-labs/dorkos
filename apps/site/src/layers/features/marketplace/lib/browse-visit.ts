import type { MarketplaceBrowseVisit } from '@/lib/analytics';
import { isKnownCategory, isKnownPackageType } from '@/lib/telemetry/marketplace-filters';

/** The catalog filters as they arrive in the page URL: any text at all. */
export interface MarketplaceBrowseFilters {
  type?: string;
  category?: string;
  q?: string;
}

/** A value that passes `isKnown`, `other` for anything else, `undefined` when absent. */
function known(value: string | undefined, isKnown: (v: string) => boolean): string | undefined {
  if (value === undefined || value === '') return undefined;
  return isKnown(value) ? value : 'other';
}

/**
 * Turn the page's filters into the visit analytics records (DOR-4992). The
 * filters come from the URL, so a person can type anything there: `type` and
 * `category` are kept only when they name a real package type or catalog
 * category (anything else becomes `other`), and the search text is reduced
 * to whether there was one.
 *
 * @param filters - The filters from the page URL.
 * @param resultCount - How many packages the page showed, or `null` when the
 *   catalog could not load.
 */
export function toBrowseVisit(
  filters: MarketplaceBrowseFilters,
  resultCount: number | null
): MarketplaceBrowseVisit {
  return {
    type: known(filters.type, isKnownPackageType),
    category: known(filters.category, isKnownCategory),
    hasQuery: Boolean(filters.q?.trim()),
    resultCount,
  };
}
