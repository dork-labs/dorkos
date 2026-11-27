/**
 * The answer a hand route gives for one page of a list (DOR-4982), in the one
 * paging shape: `cursor` and `limit` in the query, `{ <plural noun>: [...],
 * nextCursor }` back. It reads the query, refuses a cursor the list did not
 * give before the list is read (a `400` with `INVALID_CURSOR_DETAIL`, never
 * page one), and cuts the page with {@link keysetPage}.
 *
 * A route whose rows or fields differ by who is reading names the reader in
 * `list` (`pending-approvals:agent`), so a cursor one reader was given is
 * refused to another.
 *
 * @module lib/paging/hand-route-page
 */
import type { Context } from 'hono';
import { problem, validationProblem } from '@dorkos/http-kit';
import { INVALID_CURSOR_DETAIL, PageQuerySchema } from '@dorkos/shared/paging';
import { readQuery } from '../../http/request-query.js';
import { assertPageCursor, keysetPage, type PageKey } from './keyset-page.js';

/** The refusal {@link answerPage} throws and answers for a cursor its list did not give. */
class InvalidCursorError extends Error {}

const refuse = () => new InvalidCursorError();

/** What {@link answerPage} pages, and how. */
export interface HandRoutePage<T> {
  /** The list's name, bound into its cursors; name the reader when the answer differs by reader. */
  readonly list: string;
  /** The field the page's rows go in, the list's plural noun. */
  readonly noun: string;
  /** Every row the reader may see, filtered; read only once the cursor passed. */
  readonly read: () => readonly T[] | Promise<readonly T[]>;
  /** A row's place in the order: a key that never changes, then its id. */
  readonly keyOf: (row: T) => PageKey;
  /** What the answer holds for a row, when that is not the row itself. */
  readonly show?: (row: T) => unknown;
}

/**
 * Answer one page of a list, or the `400` for a query it can't page by.
 *
 * @param c - The Hono context, for the query and the answer.
 * @param page - The list, its noun, its rows and their keys.
 */
export async function answerPage<T>(c: Context, page: HandRoutePage<T>): Promise<Response> {
  const query = PageQuerySchema.strict().safeParse(readQuery(c));
  if (!query.success) return validationProblem(c, query.error);
  try {
    assertPageCursor(page.list, query.data.cursor, refuse);
    const found = keysetPage(page.list, await page.read(), page.keyOf, query.data, refuse);
    const items = page.show ? found.items.map(page.show) : found.items;
    return c.json({ [page.noun]: items, nextCursor: found.nextCursor });
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      return problem(c, 'invalid_request', { detail: INVALID_CURSOR_DETAIL });
    }
    throw error;
  }
}
