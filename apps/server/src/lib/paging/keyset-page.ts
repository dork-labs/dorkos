/**
 * One page of a list held in memory, in the one paging shape (DOR-4982):
 * newest first on a key that never changes (`[at, id]`, the id breaking a
 * tie), cut after the filters ran, so a page is never short because of them.
 *
 * The cursor is opaque: it names the list it came from and the key the page
 * stopped at. Given no reader, it is not sealed, which suits a list every
 * reader of the route sees whole. A list whose rows can be private to some
 * readers (the chat lists) names its reader, and the cursor is sealed and bound
 * to them (`sealed-cursor.ts`), because a page can stop on a row the reader may
 * not read. A cursor of another list or another reader, or
 * one that does not read as a position, is refused `INVALID_CURSOR`, never
 * read as the first page: the caller passes the refusal to throw
 * (`invalidCursor` from the capability port), so this file needs no service.
 *
 * @module lib/paging/keyset-page
 */
import type { PageQuery } from '@dorkos/shared/paging';
import { openCursor, sealCursor } from './sealed-cursor.js';

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

/**
 * The time part of a key for a list kept in a set order (a catalog, discovery
 * order) instead of by a time: the row at `index` sorts before every later
 * row, so a reader of every page gets the list in its own order. A list that
 * changes between pages can repeat or miss a row; say so where it is described.
 *
 * @param index - The row's place in the list, from 0 (below one million).
 */
export function listPosition(index: number): string {
  return String(999_999 - index).padStart(6, '0');
}

function encode(list: string, key: PageKey, sealedFor: string | undefined): string {
  const position = [list, key[0], key[1]];
  if (sealedFor !== undefined) return sealCursor(sealedFor, position);
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function decode(list: string, cursor: string, sealedFor: string | undefined): PageKey | null {
  let parsed: unknown;
  if (sealedFor !== undefined) {
    parsed = openCursor(sealedFor, cursor)?.position;
  } else {
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }
  if (
    Array.isArray(parsed) &&
    parsed.length === 3 &&
    parsed[0] === list &&
    typeof parsed[1] === 'string' &&
    typeof parsed[2] === 'string'
  ) {
    return [parsed[1], parsed[2]];
  }
  return null;
}

/**
 * The cursor for a page that stopped at `key`, for a list cut in SQL rather
 * than by {@link keysetPage} (the audit log, the Inbox, the permission
 * history): the same opaque form, sealed when `sealedFor` names a reader.
 *
 * @param list - The list's name, bound into the cursor.
 * @param key - The last row's key.
 * @param sealedFor - The reader's key, for a list whose cursors are sealed to it.
 */
export function encodePageCursor(list: string, key: PageKey, sealedFor?: string): string {
  return encode(list, key, sealedFor);
}

/**
 * Where a cursor of {@link encodePageCursor} stopped, for a list cut in SQL;
 * a cursor this list did not give, or another reader's, throws `refuse`.
 *
 * @param list - The list's name, as the cursor was given for.
 * @param cursor - The cursor as sent.
 * @param refuse - The error for a cursor this list did not give.
 * @param sealedFor - The reader's key, for a list whose cursors are sealed to it.
 */
export function openPageCursor(
  list: string,
  cursor: string,
  refuse: () => Error,
  sealedFor?: string
): PageKey {
  const key = decode(list, cursor, sealedFor);
  if (key === null) throw refuse();
  return key;
}

/**
 * The list name a sealed cursor was given for, or null for one this reader
 * can't open. For a list whose name carries what page one was read under (the
 * recent chats' `touchedSince` and when page one was read), so a later page
 * reads it back instead of trusting the caller.
 *
 * @param cursor - The cursor as sent.
 * @param sealedFor - The reader's key.
 */
export function sealedCursorList(cursor: string, sealedFor: string): string | null {
  const position = openCursor(sealedFor, cursor)?.position;
  return Array.isArray(position) && typeof position[0] === 'string' ? position[0] : null;
}

/**
 * Refuse a cursor this list did not give, before the list is read: a route
 * whose read has a cost (a sign-in check, a provider call) checks first.
 *
 * @param list - The list's name, as {@link keysetPage} is given it.
 * @param cursor - The cursor as sent, if any.
 * @param refuse - The error to throw for a cursor this list did not give.
 * @param sealedFor - The reader's key, for a list whose cursors are sealed to it.
 */
export function assertPageCursor(
  list: string,
  cursor: string | undefined,
  refuse: () => Error,
  sealedFor?: string
) {
  if (cursor !== undefined && decode(list, cursor, sealedFor) === null) throw refuse();
}

/**
 * One page of `rows`, newest first by `keyOf`, after `query.cursor`.
 *
 * @param list - The list's name, bound into its cursors so another list's is refused.
 * @param rows - Every row the reader may see, already filtered.
 * @param keyOf - A row's fixed key.
 * @param query - The cursor, if any, and the page size.
 * @param refuse - The error for a cursor this list did not give, thrown instead of page one.
 * @param sealedFor - The reader's key (`readerKey`), when rows can be private to
 *   some readers: the cursor is sealed and only this reader's opens.
 */
export function keysetPage<T>(
  list: string,
  rows: readonly T[],
  keyOf: (row: T) => PageKey,
  query: PageQuery,
  refuse: () => Error,
  sealedFor?: string
): KeysetPage<T> {
  const after = query.cursor === undefined ? null : decode(list, query.cursor, sealedFor);
  if (query.cursor !== undefined && after === null) throw refuse();
  const keyed = rows
    .map((row) => ({ row, key: keyOf(row) }))
    .filter(({ key }) => after === null || newestFirst(after, key) < 0)
    .sort((left, right) => newestFirst(left.key, right.key));
  const page = keyed.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ row }) => row),
    nextCursor: keyed.length > query.limit && last ? encode(list, last.key, sealedFor) : null,
  };
}
