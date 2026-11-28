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
 * A cursor's size is bounded whatever the list: a list name, reader key, time
 * or id longer than {@link MAX_PART_BYTES} (a project folder in a list name, an
 * agent's folder in a reader key) is held as its SHA-256 digest
 * ({@link boundedPart}), so a sealed cursor always fits its fixed length and a
 * plain one the query's limit. Rows are keyed the same way, so a long id still
 * compares with itself.
 *
 * @module lib/paging/keyset-page
 */
import { createHash } from 'node:crypto';
import type { PageQuery } from '@dorkos/shared/paging';
import { openCursor, sealCursor } from './sealed-cursor.js';

/** The most bytes (as JSON) one part of a cursor holds as itself; a longer one is digested. */
const MAX_PART_BYTES = 100;

/**
 * A cursor part as the cursor holds it: itself when short, else `#` and its
 * SHA-256 digest (44 bytes as JSON).
 *
 * @param part - A list name, reader key, time or id.
 */
function boundedPart(part: string): string {
  if (Buffer.byteLength(JSON.stringify(part), 'utf8') <= MAX_PART_BYTES) return part;
  return `#${createHash('sha256').update(part, 'utf8').digest('base64url')}`;
}

/** A row's key as a cursor holds it, each part bounded. */
function boundedKey(key: PageKey): PageKey {
  return [boundedPart(key[0]), boundedPart(key[1])];
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
  const position = [boundedPart(list), key[0], key[1]];
  if (sealedFor !== undefined) return sealCursor(boundedPart(sealedFor), position);
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function decode(list: string, cursor: string, sealedFor: string | undefined): PageKey | null {
  let parsed: unknown;
  if (sealedFor !== undefined) {
    parsed = openCursor(boundedPart(sealedFor), cursor)?.position;
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
    parsed[0] === boundedPart(list) &&
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
 * reads it back instead of trusting the caller. A name longer than
 * {@link MAX_PART_BYTES} comes back as its digest, which never matches.
 *
 * @param cursor - The cursor as sent.
 * @param sealedFor - The reader's key.
 */
export function sealedCursorList(cursor: string, sealedFor: string): string | null {
  const position = openCursor(boundedPart(sealedFor), cursor)?.position;
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
    .map((row) => ({ row, key: boundedKey(keyOf(row)) }))
    .filter(({ key }) => after === null || newestFirst(after, key) < 0)
    .sort((left, right) => newestFirst(left.key, right.key));
  const page = keyed.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ row }) => row),
    nextCursor: keyed.length > query.limit && last ? encode(list, last.key, sealedFor) : null,
  };
}

/**
 * One page of `rows` kept in their own order (a file's, a scan's, a sort the
 * list already made), keyed by {@link listPosition}: every page read in turn
 * gives the array the list answered whole. A row added or removed between
 * pages can repeat or be missed; say so where the list is described.
 *
 * @param list - The list's name, bound into its cursors.
 * @param rows - Every row the reader may see, filtered, in the list's order.
 * @param idOf - A row's id.
 * @param query - The cursor, if any, and the page size.
 * @param refuse - The error for a cursor this list did not give.
 * @param sealedFor - The reader's key, when rows read differently by reader.
 */
export function pageInOwnOrder<T>(
  list: string,
  rows: readonly T[],
  idOf: (row: T) => string,
  query: PageQuery,
  refuse: () => Error,
  sealedFor?: string
): KeysetPage<T> {
  const placed = rows.map((row, index) => ({ row, index }));
  const keyOf = ({ row, index }: (typeof placed)[number]): PageKey => [
    listPosition(index),
    idOf(row),
  ];
  const page = keysetPage(list, placed, keyOf, query, refuse, sealedFor);
  return { items: page.items.map(({ row }) => row), nextCursor: page.nextCursor };
}
