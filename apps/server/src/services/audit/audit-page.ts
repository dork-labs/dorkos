/**
 * The audit log's pages (DOR-4982): newest first by `seq`, a key that never
 * changes, cut in SQL (`AuditLog.query` and `AuditLog.timeline`), and handed
 * on with the one opaque cursor every list uses.
 *
 * The rows a reader sees depend on who they are (an agent never sees an
 * admins-only row, and a private chat's pointer is scrubbed), so a page can
 * stop on a row another reader may not read. The cursor is therefore sealed to
 * the reader (`lib/paging/sealed-cursor.ts`): another reader's cursor, or one
 * from before a restart, is refused `INVALID_CURSOR`, never read as page one.
 *
 * @module services/audit/audit-page
 */
import type {
  AuditEvent,
  AuditQuery,
  AuditQueryResult,
  AuditTimelineQuery,
} from '@dorkos/shared/audit-schemas';
import { encodePageCursor, openPageCursor } from '../../lib/paging/keyset-page.js';
import { readerKey } from '../../lib/paging/sealed-cursor.js';
import { invalidCursor } from '../core/capabilities/capability-definition.js';
import type { AuditReader } from './visibility.js';

/** A read of the log: the filters, the page size, and the `seq` the page starts below. */
export type AuditLogQuery = Omit<AuditQuery, 'cursor' | 'beforeSeq'> & { beforeSeq?: number };

/** A per-account read of the log, paged like {@link AuditLogQuery}. */
export type AuditLogTimelineQuery = Omit<AuditTimelineQuery, 'cursor' | 'beforeSeq'> & {
  beforeSeq?: number;
};

/** One page of rows, newest first, and whether more follow the last one. */
export interface AuditLogPage {
  events: AuditEvent[];
  more: boolean;
}

/** The two audit lists, each bound into its own cursors. */
export type AuditList = 'audit' | 'audit-timeline';

/**
 * The `seq` a page starts below, from the cursor the reader sent, or
 * `undefined` for the first page.
 *
 * @param list - The list the cursor must have come from.
 * @param cursor - The cursor as sent, if any.
 * @param reader - Who is reading; only their cursors open.
 * @throws {CapabilityToolError} `INVALID_CURSOR` for a cursor this list did not give this reader.
 */
export function auditCursorSeq(
  list: AuditList,
  cursor: string | undefined,
  reader: AuditReader
): number | undefined {
  if (cursor === undefined) return undefined;
  // The cursor carries [seq, id] (the shape every keyset cursor has); only seq
  // orders, because seq alone is unique and never changes.
  const [seq] = openPageCursor(list, cursor, invalidCursor, readerKey(reader));
  const parsed = Number(seq);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalidCursor();
  return parsed;
}

/**
 * The answer for one page: its rows, and a cursor sealed to the reader when
 * more follow.
 *
 * @param list - The list the page is of.
 * @param page - The rows and whether more follow.
 * @param reader - Who is reading.
 */
export function auditPageResult(
  list: AuditList,
  page: AuditLogPage,
  reader: AuditReader
): AuditQueryResult {
  const last = page.events.at(-1);
  const nextCursor =
    page.more && last
      ? encodePageCursor(list, [String(last.seq), last.id], readerKey(reader))
      : null;
  return { events: page.events, nextCursor };
}
