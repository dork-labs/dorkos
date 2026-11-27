/**
 * Every row of a paged list (`cursor` and `limit` in, `nextCursor` back,
 * DOR-4982), read page by page, for a surface that shows the whole list. The
 * caller says how one page is read, so a surface keeps its own fetch and its
 * own error words.
 *
 * @module shared/lib/read-all-pages
 */

/** The most one page of a list holds; a full-list read asks for this many at a time. */
export const LIST_PAGE_LIMIT = 200;

/** The most pages one full-list read follows: 10,000 rows, far past any list the app shows. */
const LIST_PAGE_CAP = 50;

/**
 * Read every page of a list, following `nextCursor` until it is null.
 *
 * @param read - Reads one page: the first with no cursor, each next with the one before's.
 * @param rowsOf - The rows one page holds.
 * @param label - What the error names when the list never ends.
 * @returns The first page, as the server sent it, and every row in server order.
 * @throws {Error} When a cursor comes back twice, or past {@link LIST_PAGE_CAP} pages.
 */
export async function readAllPages<P extends { nextCursor: string | null }, T>(
  read: (cursor?: string) => Promise<P>,
  rowsOf: (page: P) => readonly T[],
  label: string
): Promise<{ first: P; rows: T[] }> {
  const first = await read();
  const rows: T[] = [...rowsOf(first)];
  const seen = new Set<string>();
  for (let cursor = first.nextCursor, pages = 1; cursor; pages++) {
    // A server that hands back a cursor twice, or never ends, must not spin the app forever.
    if (seen.has(cursor) || pages >= LIST_PAGE_CAP) {
      throw new Error(`${label} kept giving more pages; stopped after ${pages}.`);
    }
    seen.add(cursor);
    const page = await read(cursor);
    rows.push(...rowsOf(page));
    cursor = page.nextCursor;
  }
  return { first, rows };
}

/**
 * The query string of one page of a full-list read.
 *
 * @param cursor - The cursor of the page before, if any.
 */
export function pageQuery(cursor?: string): string {
  const params = new URLSearchParams({ limit: String(LIST_PAGE_LIMIT) });
  if (cursor) params.set('cursor', cursor);
  return `?${params.toString()}`;
}
