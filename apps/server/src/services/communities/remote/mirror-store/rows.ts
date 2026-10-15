/**
 * Row helpers for the remote community mirror: the mirror lookup, accessor de-duplication,
 * cached-entry rehydration, and the attachment-drop matcher a redaction page applies.
 *
 * @module services/communities/remote/mirror-store/rows
 */
import {
  and,
  communityRoomMirrors,
  eq,
  roomAttachments,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  CommunityEntrySchema,
  type CommunityAttachment,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import type { CachedRemoteEntry, MirrorAccessor, MirrorAttachmentFile } from './types.js';

/**
 * The local files of one rewritten entry that the Community no longer carries on it.
 *
 * Matched on identity, never on the name: the Community cleans names on upload, and two files
 * may share a name and a size, so a name match can both delete a file the message still has and
 * keep the one that was removed.
 *
 * - A message with no files left on the Community (deleted, removed, erased) drops every local
 *   file of it: there is nothing left for any of them to be.
 * - A file delivered with its Community id recorded is dropped exactly when the Community no
 *   longer lists that id on the message.
 * - A file delivered before ids were recorded is matched on its bytes' SHA-256, which the
 *   Community lists as the checksum: `checksums` carries it, read by the caller outside the
 *   transaction. Each remaining Community file vouches for at most one local file.
 * - A file with neither an id nor a known checksum is KEPT. A file wrongly kept is still the
 *   owner's to remove; one wrongly deleted is gone from everywhere they could reach it.
 *
 * @param db - The database or open transaction to read from.
 * @param localRoomId - The mirror's local room.
 * @param localEntryId - The rewritten local entry.
 * @param remaining - The files the entry still has on the Community.
 * @param checksums - SHA-256 of the local bytes, by local attachment id, for files without a
 *   recorded Community id.
 */
export function attachmentsToDrop(
  db: Pick<Db, 'select'> | Pick<DbTransaction, 'select'>,
  localRoomId: string,
  localEntryId: string,
  remaining: readonly CommunityAttachment[],
  checksums: ReadonlyMap<string, string>
): Array<MirrorAttachmentFile & { id: string }> {
  const rows = (db as Db)
    .select({
      id: roomAttachments.id,
      extension: roomAttachments.extension,
      communityAttachmentId: roomAttachments.communityAttachmentId,
    })
    .from(roomAttachments)
    .where(and(eq(roomAttachments.roomId, localRoomId), eq(roomAttachments.entryId, localEntryId)))
    .all();
  const file = (row: (typeof rows)[number]) => ({
    id: row.id,
    roomId: localRoomId,
    attachmentId: row.id,
    extension: row.extension,
  });
  if (remaining.length === 0) return rows.map(file);
  const listed = new Set(remaining.map((item) => item.id));
  const claimed = new Set(rows.map((row) => row.communityAttachmentId).filter(Boolean));
  // Community files no identified local file accounts for, for the legacy files to match on.
  const unclaimed = remaining.filter((item) => !claimed.has(item.id));
  const dropped: Array<MirrorAttachmentFile & { id: string }> = [];
  for (const row of rows) {
    if (row.communityAttachmentId) {
      if (!listed.has(row.communityAttachmentId)) dropped.push(file(row));
      continue;
    }
    const checksum = checksums.get(row.id);
    if (checksum === undefined) continue;
    const match = unclaimed.findIndex((item) => item.checksum === checksum);
    if (match === -1) dropped.push(file(row));
    else unclaimed.splice(match, 1);
  }
  return dropped;
}

/** Keep the owner and every explicitly enrolled agent exactly once. */
export function dedupeAccessors(
  ownerAuthorId: string,
  accessors: readonly MirrorAccessor[]
): MirrorAccessor[] {
  const values = new Map<string, MirrorAccessor>();
  values.set(ownerAuthorId, { authorId: ownerAuthorId, responseMode: 'silent' });
  for (const accessor of accessors) values.set(accessor.authorId, accessor);
  return [...values.values()];
}

/** Rehydrate optional native provenance without inferring anything from a label. */
export function toCachedEntry(row: {
  entryJson: string | null;
  remoteSeq: number;
  authorDisplayName: string | null;
  authorKind: string | null;
}): CachedRemoteEntry | null {
  if (!row.entryJson) return null;
  const entry = CommunityEntrySchema.parse(JSON.parse(row.entryJson));
  const author = isNativeAuthorKind(row.authorKind)
    ? {
        memberId: entry.authorId,
        displayName: row.authorDisplayName ?? entry.authorId,
        kind: row.authorKind,
      }
    : null;
  return { entry, remoteSeq: row.remoteSeq, author };
}

/** The three native member kinds the remote server vouches for on its wire. */
export function isNativeAuthorKind(value: string | null): value is 'human' | 'agent' | 'system' {
  return value === 'human' || value === 'agent' || value === 'system';
}

/**
 * The persisted mirror row of one remote room, whatever its state, or `undefined`.
 *
 * @param db - The database the mirror lives in.
 */
export function findMirror(db: Db, communityRef: CommunityRef, remoteRoomId: string) {
  return db
    .select()
    .from(communityRoomMirrors)
    .where(
      and(
        eq(communityRoomMirrors.communityRef, communityRef),
        eq(communityRoomMirrors.remoteRoomId, remoteRoomId)
      )
    )
    .get();
}
