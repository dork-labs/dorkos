'use client';

import { useEffect, useRef } from 'react';
import { trackMarketplaceBrowse, type MarketplaceBrowseFilters } from '@/lib/analytics';

/**
 * MarketplaceBrowseTracker — fires the `marketplace_browse` funnel event.
 *
 * The `/marketplace` page is server-rendered (ISR), so this tiny client
 * component is the mount point: it fires once per distinct filter set,
 * covering both a fresh visit and a same-page filter change (type/category/q
 * query params). The search text is read here only to tell one filter set
 * from the next; the event itself never carries it. Renders nothing.
 *
 * @module features/marketplace/ui/MarketplaceBrowseTracker
 */
export function MarketplaceBrowseTracker({
  type,
  category,
  q,
  resultCount,
}: MarketplaceBrowseFilters & { resultCount: number }) {
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = `${type ?? ''}|${category ?? ''}|${q ?? ''}`;
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    trackMarketplaceBrowse({ type, category, q, resultCount });
  }, [type, category, q, resultCount]);

  return null;
}
