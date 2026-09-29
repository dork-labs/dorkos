/**
 * Keeps the inbox honest when a room message changes or its room goes away after the
 * notification about it was written — a Community message deleted, removed, or erased
 * (specs/community-member-erasure task 2.1).
 *
 * A `dm.received` or `mention.received` row quotes its entry: the preview is its body, and the
 * payload names the entry by `roomId` and `entryId`. So a change to that entry is matched
 * exactly, never by comparing text. Other kinds that name a room carry no entry, and quote no
 * room message.
 *
 * @module services/notifications/room-entry-notifications
 */
import { notifications, and, eq, inArray, type Db } from '@dorkos/db';
import { roomMessagePreview } from './emitters/room-messages.js';
import { notificationEntry } from './notification-registry.js';

/** A database or an open transaction on it. */
type Writer = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** The kinds that quote a room entry. */
const QUOTING_KINDS = ['dm.received', 'mention.received'] as const;

/**
 * Rewrite every notification that quotes one room entry to what the entry says now: its body,
 * the preview in its payload, and — when the author's name changed (an erasure) — the name in
 * its title. Web push is sent at once and never stored, so the inbox rows are the only copy.
 *
 * @param writer - The database, or the transaction that changed the entry.
 * @param roomId - The entry's room.
 * @param entryId - The entry's local id.
 * @param change - The entry's text now, and its author's name when that changed.
 * @returns How many notifications were rewritten.
 */
export function rewriteRoomEntryNotifications(
  writer: Writer,
  roomId: string,
  entryId: string,
  change: { text: string; fromName?: string }
): number {
  const rows = writer
    .select({ id: notifications.id, kind: notifications.kind, dataJson: notifications.dataJson })
    .from(notifications)
    .where(and(eq(notifications.roomId, roomId), inArray(notifications.kind, [...QUOTING_KINDS])))
    .all();
  let rewritten = 0;
  for (const row of rows) {
    const payload = parseQuote(row.dataJson);
    if (!payload || payload.entryId !== entryId) continue;
    const next = {
      ...payload,
      preview: roomMessagePreview(change.text),
      ...(change.fromName ? { fromName: change.fromName } : {}),
    };
    const kind = row.kind as (typeof QUOTING_KINDS)[number];
    const entry = notificationEntry(kind);
    writer
      .update(notifications)
      .set({
        title: entry.title(next as never),
        body: entry.body?.(next as never) ?? null,
        dataJson: JSON.stringify(next),
      })
      .where(eq(notifications.id, row.id))
      .run();
    rewritten += 1;
  }
  return rewritten;
}

/**
 * Delete every notification about rooms that no longer exist here (a revoked Community mirror).
 * Their delivery ledger rows cascade.
 *
 * @param writer - The database, or the transaction that deleted the rooms.
 * @param roomIds - The deleted rooms.
 */
export function deleteRoomNotifications(writer: Writer, roomIds: readonly string[]): void {
  if (!roomIds.length) return;
  writer
    .delete(notifications)
    .where(inArray(notifications.roomId, [...roomIds]))
    .run();
}

/** The quoting part of a stored payload, or `null` when it is not one. */
function parseQuote(
  dataJson: string | null
): (Record<string, unknown> & { entryId?: unknown }) | null {
  if (!dataJson) return null;
  try {
    const value = JSON.parse(dataJson) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
