/**
 * Every row of a paged list (`cursor` and `limit` in, `{ <rows>, nextCursor }`
 * back, DOR-4982), read page by page through {@link apiCall}, for a command
 * that shows or searches the whole list. Rows keep the server's order.
 *
 * @module lib/read-all-pages
 */
import { apiCall } from './api-client.js';

/** The page size a whole-list read asks for: the most one page may hold. */
const PAGE_LIMIT = 200;

/** A list longer than this many pages is a server that never stops, not a long list. */
const MAX_PAGES = 500;

/**
 * Read every page of a list.
 *
 * @param path - The list's path, without a query string (e.g. `/api/marketplace/sources`).
 * @param params - The list's own query fields; an undefined value is left out.
 * @param rowsOf - The rows one page holds.
 * @returns The first page, as the server sent it, and every row in server order.
 * @throws {Error} When the server keeps answering a cursor past {@link MAX_PAGES} pages.
 */
export async function readAllPages<P extends { nextCursor: string | null }, T>(
  path: string,
  params: Record<string, string | undefined>,
  rowsOf: (page: P) => readonly T[]
): Promise<{ first: P; rows: T[] }> {
  const read = (cursor: string | undefined) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, cursor })) {
      if (value !== undefined) query.set(key, value);
    }
    query.set('limit', String(PAGE_LIMIT));
    return apiCall<P>('GET', `${path}?${query.toString()}`);
  };
  const first = await read(undefined);
  const rows = [...rowsOf(first)];
  let cursor = first.nextCursor;
  for (let pages = 1; cursor; pages++) {
    if (pages >= MAX_PAGES) throw new Error(`${path} kept giving pages past ${MAX_PAGES}.`);
    const page = await read(cursor);
    rows.push(...rowsOf(page));
    cursor = page.nextCursor;
  }
  return { first, rows };
}

/**
 * Every row of a paged list whose rows sit under `noun`, with no query of its own.
 *
 * @param path - The list's path, without a query string.
 * @param noun - The field one page holds its rows in (`agents`, `packages`).
 */
export async function readAllRows<T>(path: string, noun: string): Promise<T[]> {
  type Page = { nextCursor: string | null } & Record<string, unknown>;
  return (await readAllPages(path, {}, (page: Page) => page[noun] as T[])).rows;
}
