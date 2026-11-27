/**
 * One page of a list held in memory, in the one paging shape (DOR-4982):
 * newest first on a key that never changes (`[at, id]`, the id breaking a
 * tie), cut after the filters ran, so a page is never short because of them.
 *
 * The cursor is opaque but not sealed: it names the list it came from and the
 * key the page stopped at, nothing a reader could not already see. Use it for
 * lists every reader of the route sees whole; a list whose rows can be private
 * to some readers seals its cursor to the reader instead
 * (`services/work-graph/reads/page-cursor.ts`). A cursor of another list, or
 * one that does not read as a position, is refused `INVALID_CURSOR`, never
 * read as the first page.
 *
 * @module lib/paging/keyset-page
 */
import type { PageQuery } from '@dorkos/shared/paging';
import { CapabilityToolError } from '../../services/core/capabilities/capability-definition.js';

/** The sentence a refused cursor answers with, on hand routes and the mount alike. */
export const INVALID_CURSOR_DETAIL =
  'That cursor wasn’t given by this list. Leave it out to start again.';

/** The refusal for a cursor a list can't go on from. */
export function invalidCursor(): CapabilityToolError {
  return new CapabilityToolError({
    code: 'INVALID_CURSOR',
    error: 'That cursor was not given by this list. Leave it out to start again.',
  });
}

/**
 * Whether an error is the refusal {@link invalidCursor} makes, for a hand
 * route to answer `400` with {@link INVALID_CURSOR_DETAIL}.
 *
 * @param error - What was thrown.
 */
export function isInvalidCursor(error: unknown): boolean {
  return (
    error instanceof CapabilityToolError &&
    (error.payload as { code?: unknown } | null)?.code === 'INVALID_CURSOR'
  );
}

/** A row's place in the order: a key that never changes (a time, as ISO 8601), then its id. */
export type PageKey = readonly [at: string, id: string];

/** One page of rows, and where the next one starts. */
export interface KeysetPage<T> {
  /** The rows on this page, newest first. */
  items: T[];
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

/** Newest first, the higher id first on a tie. */
function newestFirst(left: PageKey, right: PageKey): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? 1 : -1;
  if (left[1] === right[1]) return 0;
  return left[1] < right[1] ? 1 : -1;
}

function encode(list: string, key: PageKey): string {
  return Buffer.from(JSON.stringify([list, key[0], key[1]]), 'utf8').toString('base64url');
}

function decode(list: string, cursor: string): PageKey {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === list &&
      typeof parsed[1] === 'string' &&
      typeof parsed[2] === 'string'
    ) {
      return [parsed[1], parsed[2]];
    }
  } catch {
    // Falls through to the refusal.
  }
  throw invalidCursor();
}

/**
 * One page of `rows`, newest first by `keyOf`, after `query.cursor`.
 *
 * @param list - The list's name, bound into its cursors so another list's is refused.
 * @param rows - Every row the reader may see, already filtered.
 * @param keyOf - A row's fixed key.
 * @param query - The cursor, if any, and the page size.
 * @throws {CapabilityToolError} `INVALID_CURSOR` for a cursor this list did not give.
 */
export function keysetPage<T>(
  list: string,
  rows: readonly T[],
  keyOf: (row: T) => PageKey,
  query: PageQuery
): KeysetPage<T> {
  const after = query.cursor === undefined ? null : decode(list, query.cursor);
  const keyed = rows
    .map((row) => ({ row, key: keyOf(row) }))
    .filter(({ key }) => after === null || newestFirst(after, key) < 0)
    .sort((left, right) => newestFirst(left.key, right.key));
  const page = keyed.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ row }) => row),
    nextCursor: keyed.length > query.limit && last ? encode(list, last.key) : null,
  };
}
