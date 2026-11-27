/**
 * The work graph reads' page cursor: where a page stopped, sealed so the
 * caller can't read it and bound to its reader (`lib/paging/sealed-cursor.ts`).
 * Where a page stops can be a chat the reader may not read (the last binding
 * an `agent_chats` scan stopped at, a joint a tree page ended on), so it must
 * never be readable from the cursor (Security, DOR-4970). The reader is the
 * owner, or an agent's account id, as `readerFor` names it.
 *
 * A cursor this process did not seal is refused `INVALID_CURSOR`, never read
 * as the first page. So one from before a restart is too: the caller starts
 * again.
 *
 * @module services/work-graph/reads/page-cursor
 */
import { invalidCursor } from '../../core/capabilities/capability-definition.js';
import type { AuditReader } from '../../audit/visibility.js';
import {
  openCursor,
  PAGE_CURSOR_BYTES,
  readerKey,
  sealCursor,
} from '../../../lib/paging/sealed-cursor.js';

/**
 * The cursor for where a page stopped.
 *
 * @param reader - Who got the page; only they may go on from it.
 * @param position - Where it stopped, as JSON.
 * @param bytes - The fixed length its contents are padded to.
 * @throws {Error} When the position does not fit, which is a bug in the caller.
 */
export function encodePageCursor(
  reader: AuditReader,
  position: unknown,
  bytes: number = PAGE_CURSOR_BYTES
): string {
  return sealCursor(readerKey(reader), position, bytes);
}

/**
 * Where a page stopped, as its cursor holds it, for the reader it was given to.
 *
 * @param reader - Who sends it.
 * @param cursor - The cursor as sent.
 * @param bytes - The fixed length its contents were padded to.
 * @returns The position, as JSON for the caller to check.
 * @throws {CapabilityToolError} `INVALID_CURSOR` for a cursor this process did
 *   not seal, of another length, or given to another reader.
 */
export function decodePageCursor(
  reader: AuditReader,
  cursor: string,
  bytes: number = PAGE_CURSOR_BYTES
): unknown {
  const opened = openCursor(readerKey(reader), cursor, bytes);
  if (!opened) throw invalidCursor();
  return opened.position;
}

/**
 * A position of two strings, or the refusal.
 *
 * @param position - What {@link decodePageCursor} returned.
 */
export function pairOf(position: unknown): [string, string] {
  if (
    Array.isArray(position) &&
    position.length === 2 &&
    typeof position[0] === 'string' &&
    typeof position[1] === 'string'
  ) {
    return [position[0], position[1]];
  }
  throw invalidCursor();
}
