/**
 * An extension page's query: read flat, written back exactly (spec
 * `flow-multiproject` §6.5).
 *
 * @module widgets/extension-page/model/page-search
 */
import type { AnyRouter } from '@tanstack/react-router';

/**
 * The query an extension page receives: every key once, every value the text
 * the address holds. A key given twice keeps its last value.
 *
 * @param searchStr - The location's search string, with or without its `?`.
 */
export function pageSearchFrom(searchStr: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(searchStr));
}

/**
 * The `setSearch` an extension page is handed: merge keys into the address
 * (`null` removes one).
 *
 * Two rules a page relies on without thinking about them:
 *
 * - **It replaces the history entry.** A page that writes its filter box into
 *   the address on every keystroke must not leave one Back press per letter.
 * - **Calls compose.** Two calls in one tick both land: each one starts from
 *   what the previous one wrote, not from the location the page rendered with,
 *   which the router has not caught up to yet.
 *
 * @param router - The app's router.
 */
export function createPageSearchWriter(
  router: AnyRouter
): (next: Record<string, string | null>) => Promise<void> {
  // What this writer last sent and has not yet seen land, keyed by the path it
  // was written for, so a write after a navigation elsewhere starts fresh.
  let pending: { pathname: string; searchStr: string } | null = null;

  return async (next) => {
    const { pathname, searchStr: current } = router.latestLocation;
    const base = pending !== null && pending.pathname === pathname ? pending.searchStr : current;
    const params = new URLSearchParams(base);
    for (const [key, value] of Object.entries(next)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    const searchStr = query ? `?${query}` : '';
    const written = { pathname, searchStr };
    pending = written;
    try {
      await router.navigate({ href: `${pathname}${searchStr}`, replace: true });
    } finally {
      if (pending === written) pending = null;
    }
  };
}
