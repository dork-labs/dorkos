/**
 * One page of a chat list (DOR-4982): `GET /api/sessions` and
 * `GET /api/sessions/recent`, in the one paging shape.
 *
 * **Order: latest activity first** (`updatedAt`, then the id), the order the
 * chat list and the sidebar have always shown. That key moves: a chat that
 * gets a new message while a caller pages can repeat or be missed. A fixed key
 * (when a chat started) was the other choice, and it would push a chat you
 * reopened today off the first page, so the lists keep the moving key and say
 * so in the API document.
 *
 * **Who reads.** A chat list is filtered per reader before the page is cut,
 * and its cursor is sealed to that reader (`lib/paging/sealed-cursor.ts`): a
 * page can stop on a chat another reader may not read. Another reader's
 * cursor, or one from before a restart, is refused, never read as page one.
 *
 * @module services/session/catalog/session-list-page
 */
import type { PageQuery } from '@dorkos/shared/paging';
import type { Session } from '@dorkos/shared/types';
import { keysetPage, type KeysetPage, type PageKey } from '../../../lib/paging/keyset-page.js';

/** How one chat list is paged: its name, the page asked for, and who asks. */
export interface SessionPageOptions {
  /** The list's name, bound into its cursors so another list's is refused. */
  list: string;
  /** The cursor, if any, and the page size. */
  query: PageQuery;
  /** The reader's key (`readerKey`); the cursor is sealed to it. */
  sealedFor: string;
  /** The error for a cursor this list and reader did not get, thrown instead of page one. */
  refuse: () => Error;
}

/**
 * A chat's place in a chat list: its latest activity, then its id. Read as an
 * instant, so two spellings of one time sort as one.
 *
 * @param session - The chat.
 */
export function sessionActivityKey(session: Session): PageKey {
  const at = Date.parse(session.updatedAt);
  return [Number.isNaN(at) ? '' : new Date(at).toISOString(), session.id];
}

/**
 * One page of chats, latest activity first.
 *
 * @param rows - Every chat the reader may read.
 * @param options - See {@link SessionPageOptions}.
 */
export function sessionListPage(
  rows: readonly Session[],
  options: SessionPageOptions
): KeysetPage<Session> {
  const { list, query, refuse, sealedFor } = options;
  return keysetPage(list, rows, sessionActivityKey, query, refuse, sealedFor);
}

/**
 * One page of the recent chats across every agent. The first page also holds
 * each chat named in `kept` (every chat you touched today, spec
 * `your-activity-first` D6) that falls past it, once, in its place, so no
 * page size drops one. Later pages leave the kept chats out, so none repeats.
 *
 * @param rows - Every chat the reader may read, latest activity first.
 * @param kept - The chats the first page holds wherever they fall.
 * @param options - See {@link SessionPageOptions}.
 */
export function recentSessionsPage(
  rows: readonly Session[],
  kept: ReadonlySet<string>,
  options: SessionPageOptions
): KeysetPage<Session> {
  const first = options.query.cursor === undefined;
  const page = sessionListPage(first ? rows : rows.filter((s) => !kept.has(s.id)), options);
  if (!first || kept.size === 0) return page;
  // A chat two runtimes or two agent folders both list appears twice in
  // `rows`; past the page, it is added once, and never when the page holds it.
  const listed = new Set(page.items.map((session) => session.id));
  const items = [...page.items];
  for (const session of rows) {
    if (!kept.has(session.id) || listed.has(session.id)) continue;
    listed.add(session.id);
    items.push(session);
  }
  return { items, nextCursor: page.nextCursor };
}
