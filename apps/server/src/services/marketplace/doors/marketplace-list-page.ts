/**
 * One page of a marketplace list (DOR-4982), in the order the whole list has
 * always come in: sources in the order the sources file keeps them, packages
 * source by source as each listing names them, installations in scan order.
 * None of these is a sort, so each row's key is its place in that order
 * (`listPosition`), and a reader of every page gets the array the list
 * answered before it paged. A source, package or installation added or
 * removed between pages can repeat or be missed; each list's description says
 * so.
 *
 * A list whose rows read differently for an agent (the installations and the
 * held-back packages, without a person's folders) seals its cursor to the
 * reader (`lib/paging/caller-reader-key.ts`), so a cursor one reader was given
 * does not open for another. The rest are the same for every reader and use a
 * plain opaque cursor.
 *
 * @module services/marketplace/doors/marketplace-list-page
 */
import type { PageQuery } from '@dorkos/shared/paging';

import { invalidCursor } from '../../core/capabilities/capability-definition.js';
import { assertPageCursor, pageInOwnOrder } from '../../../lib/paging/keyset-page.js';

/** What every marketplace list's description says about paging. */
export const PAGES =
  ' A page at a time, in the list’s own order: pass `nextCursor` back as `cursor` for the ' +
  'next page. One added or removed while paging can repeat or be missed.';

/** Where a marketplace list goes on from, and for whom. */
export interface MarketplacePageOptions {
  /** The list's name, bound into its cursors; name what the rows were read under. */
  readonly list: string;
  /** The cursor and page size. */
  readonly query: PageQuery;
  /** The reader's key, for a list whose rows read differently by reader. */
  readonly sealedFor?: string;
}

/**
 * Refuse a cursor the list did not give, before the list is read: a scan or a
 * fetch is not spent on a page that would be refused.
 *
 * @param options - The list, the query and the reader.
 */
export function assertMarketplaceCursor(options: MarketplacePageOptions): void {
  assertPageCursor(options.list, options.query.cursor, invalidCursor, options.sealedFor);
}

/**
 * One page of `rows`, kept in their own order.
 *
 * @param rows - Every row of the list, filtered, in the order the list keeps.
 * @param idOf - A row's id, for the cursor.
 * @param options - The list, the query and the reader.
 */
export function pageInListOrder<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  options: MarketplacePageOptions
): { items: T[]; nextCursor: string | null } {
  const { list, query, sealedFor } = options;
  return pageInOwnOrder(list, rows, idOf, query, invalidCursor, sealedFor);
}
