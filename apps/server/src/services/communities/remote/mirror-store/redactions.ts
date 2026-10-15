/**
 * The redaction half of the remote community mirror: finding every local copy of a changed
 * Community entry, planning which of its files go, and rewriting the copies in one transaction.
 *
 * @module services/communities/remote/mirror-store/redactions
 */
import {
  and,
  communityMirrorEntries,
  communityMirrorRedactions,
  communityOutbox,
  communityRoomMirrors,
  eq,
  inArray,
  isNull,
  roomAttachments,
  roomEntries,
  type Db,
} from '@dorkos/db';
import { CommunityEntrySchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import { rewriteRoomEntryNotifications } from '../../../notifications/room-entry-notifications.js';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';
import { attachmentsToDrop } from './rows.js';
import type { AppliedRedactions, MirrorAttachmentFile, NativeMirrorEntry } from './types.js';

/**
 * The local entries that copy one Community entry: a local agent's post the outbox delivered
 * as it, and a cached copy of it.
 *
 * @param db - The database the mirror lives in.
 */
export function localCopiesOf(
  db: Db,
  communityRef: CommunityRef,
  remoteRoomId: string,
  ownerAuthorId: string,
  remoteEntryId: string
): string[] {
  const delivered = db
    .select({ localEntryId: communityOutbox.localEntryId })
    .from(communityOutbox)
    .where(
      and(
        eq(communityOutbox.communityRef, communityRef),
        eq(communityOutbox.remoteRoomId, remoteRoomId),
        eq(communityOutbox.ownerAuthorId, ownerAuthorId),
        eq(communityOutbox.remoteEntryId, remoteEntryId)
      )
    )
    .all();
  const cached = db
    .select({ localEntryId: communityMirrorEntries.localEntryId })
    .from(communityMirrorEntries)
    .where(
      and(
        eq(communityMirrorEntries.communityRef, communityRef),
        eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
        eq(communityMirrorEntries.remoteEntryId, remoteEntryId)
      )
    )
    .all();
  return [...delivered, ...cached].map((row) => row.localEntryId);
}

/**
 * The body of `RemoteMirrorStore.attachmentsNeedingChecksum` after its mirror lookup.
 *
 * @param db - The database the mirror lives in.
 * @param mirror - The owner's live mirror of the remote room.
 */
export function attachmentsNeedingChecksumIn(
  db: Db,
  mirror: { localRoomId: string },
  communityRef: CommunityRef,
  remoteRoomId: string,
  ownerAuthorId: string,
  items: readonly NativeMirrorEntry[]
): Array<MirrorAttachmentFile & { mimeType: string }> {
  const needed: Array<MirrorAttachmentFile & { mimeType: string }> = [];
  for (const item of items) {
    if (!item.entry.attachments?.length) continue;
    for (const localEntryId of localCopiesOf(
      db,
      communityRef,
      remoteRoomId,
      ownerAuthorId,
      item.entry.id
    )) {
      for (const row of db
        .select({
          id: roomAttachments.id,
          extension: roomAttachments.extension,
          mimeType: roomAttachments.mimeType,
        })
        .from(roomAttachments)
        .where(
          and(
            eq(roomAttachments.roomId, mirror.localRoomId),
            eq(roomAttachments.entryId, localEntryId),
            isNull(roomAttachments.communityAttachmentId)
          )
        )
        .all())
        needed.push({
          roomId: mirror.localRoomId,
          attachmentId: row.id,
          extension: row.extension,
          mimeType: row.mimeType,
        });
    }
  }
  return needed;
}

/**
 * The body of `RemoteMirrorStore.plannedAttachmentDrops` after its mirror lookup.
 *
 * @param db - The database the mirror lives in.
 * @param mirror - The owner's live mirror of the remote room.
 */
export function plannedAttachmentDropsIn(
  db: Db,
  mirror: { localRoomId: string },
  communityRef: CommunityRef,
  remoteRoomId: string,
  ownerAuthorId: string,
  items: readonly NativeMirrorEntry[],
  checksums: ReadonlyMap<string, string>
): MirrorAttachmentFile[] {
  const planned: MirrorAttachmentFile[] = [];
  for (const item of items) {
    if (item.entry.community !== communityRef || item.entry.roomId !== remoteRoomId) continue;
    for (const localEntryId of localCopiesOf(
      db,
      communityRef,
      remoteRoomId,
      ownerAuthorId,
      item.entry.id
    )) {
      for (const { roomId, attachmentId, extension } of attachmentsToDrop(
        db,
        mirror.localRoomId,
        localEntryId,
        item.entry.attachments ?? [],
        checksums
      ))
        planned.push({ roomId, attachmentId, extension });
    }
  }
  return planned;
}

/**
 * The body of `RemoteMirrorStore.applyRedactions` after its mirror lookup: check the page,
 * then rewrite every copy and store the feed position in one transaction.
 *
 * @param db - The database the mirror lives in.
 * @param authors - Renames an erased external author.
 * @param mirror - The owner's live mirror of the remote room.
 */
export function applyRedactionPage(
  db: Db,
  authors: AuthorRegistry,
  mirror: { localRoomId: string },
  communityRef: CommunityRef,
  remoteRoomId: string,
  ownerAuthorId: string,
  items: readonly NativeMirrorEntry[],
  nextCursor: string,
  checksums: ReadonlyMap<string, string>
): AppliedRedactions {
  for (const item of items) {
    if (item.entry.community !== communityRef || item.entry.roomId !== remoteRoomId) {
      throw new Error('A changed community entry does not belong to this mirror');
    }
  }
  const localRoomId = mirror.localRoomId;
  return db.transaction(
    (tx) => {
      const changedSeqs: number[] = [];
      const droppedAttachments: MirrorAttachmentFile[] = [];
      const rewrite = (
        localEntryId: string,
        item: NativeMirrorEntry,
        keepMentions: boolean,
        renamedTo?: string
      ) => {
        const row = tx
          .update(roomEntries)
          .set({
            body: JSON.stringify({ text: item.entry.text }),
            // A local post's mentions are local author ids; a change only ever removes them.
            ...(keepMentions && item.entry.mentions.length
              ? {}
              : { mentions: JSON.stringify(item.entry.mentions), mentionSpans: '[]' }),
          })
          .where(and(eq(roomEntries.roomId, localRoomId), eq(roomEntries.id, localEntryId)))
          .returning({ seq: roomEntries.seq })
          .get();
        if (!row) return;
        changedSeqs.push(row.seq);
        // Its files are copies too: a file the Community no longer has on the entry stops
        // being offered here, in this transaction (DOR-2549). The bytes go after the commit.
        const drop = attachmentsToDrop(
          tx,
          localRoomId,
          localEntryId,
          item.entry.attachments ?? [],
          checksums
        );
        if (drop.length) {
          tx.delete(roomAttachments)
            .where(
              and(
                eq(roomAttachments.roomId, localRoomId),
                inArray(
                  roomAttachments.id,
                  drop.map((file) => file.id)
                )
              )
            )
            .run();
          for (const { roomId, attachmentId, extension } of drop)
            droppedAttachments.push({ roomId, attachmentId, extension });
        }
        // An inbox notification that quoted the entry is a copy too.
        rewriteRoomEntryNotifications(tx, localRoomId, localEntryId, {
          text: item.entry.text,
          ...(renamedTo ? { fromName: renamedTo } : {}),
        });
      };
      for (const item of items) {
        const entryJson = JSON.stringify(CommunityEntrySchema.parse(item.entry));
        const delivered = tx
          .select({ localEntryId: communityOutbox.localEntryId })
          .from(communityOutbox)
          .where(
            and(
              eq(communityOutbox.communityRef, communityRef),
              eq(communityOutbox.remoteRoomId, remoteRoomId),
              eq(communityOutbox.ownerAuthorId, ownerAuthorId),
              eq(communityOutbox.remoteEntryId, item.entry.id)
            )
          )
          .all();
        for (const post of delivered) rewrite(post.localEntryId, item, true);
        const cached = tx
          .select({
            localEntryId: communityMirrorEntries.localEntryId,
            entryJson: communityMirrorEntries.entryJson,
            authorDisplayName: communityMirrorEntries.authorDisplayName,
            authorKind: communityMirrorEntries.authorKind,
          })
          .from(communityMirrorEntries)
          .where(
            and(
              eq(communityMirrorEntries.communityRef, communityRef),
              eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
              eq(communityMirrorEntries.remoteEntryId, item.entry.id)
            )
          )
          .get();
        if (!cached) {
          // Remembered even when a local post was rewritten above: the post's own echo may
          // still arrive from the stream, and must be stored as it is now.
          tx.insert(communityMirrorRedactions)
            .values({
              communityRef,
              remoteRoomId,
              remoteEntryId: item.entry.id,
              entryJson,
              authorDisplayName: item.author.displayName,
              authorKind: item.author.kind,
            })
            .onConflictDoUpdate({
              target: [
                communityMirrorRedactions.communityRef,
                communityMirrorRedactions.remoteRoomId,
                communityMirrorRedactions.remoteEntryId,
              ],
              set: {
                entryJson,
                authorDisplayName: item.author.displayName,
                authorKind: item.author.kind,
              },
            })
            .run();
          continue;
        }
        if (
          cached.entryJson === entryJson &&
          cached.authorDisplayName === item.author.displayName &&
          cached.authorKind === item.author.kind
        ) {
          continue;
        }
        if (cached.authorDisplayName !== item.author.displayName) {
          // Only erasure changes the name a message shows. Its handle was derived from the
          // erased name, so it is re-derived too.
          authors.renameErasedExternal({
            platformType: 'community',
            instanceId: communityRef,
            platformUserId: item.author.memberId,
            displayName: item.author.displayName,
          });
        }
        rewrite(
          cached.localEntryId,
          item,
          false,
          cached.authorDisplayName !== item.author.displayName ? item.author.displayName : undefined
        );
        tx.update(communityMirrorEntries)
          .set({
            entryJson,
            authorDisplayName: item.author.displayName,
            authorKind: item.author.kind,
          })
          .where(
            and(
              eq(communityMirrorEntries.communityRef, communityRef),
              eq(communityMirrorEntries.remoteRoomId, remoteRoomId),
              eq(communityMirrorEntries.remoteEntryId, item.entry.id)
            )
          )
          .run();
      }
      tx.update(communityRoomMirrors)
        .set({ redactionCursor: nextCursor })
        .where(eq(communityRoomMirrors.localRoomId, localRoomId))
        .run();
      return { localRoomId, changedSeqs, droppedAttachments };
    },
    { behavior: 'immediate' }
  );
}

/**
 * The body of `RemoteMirrorStore.resetRedactionCursor`: forget a mirror's redaction feed
 * position.
 *
 * @param db - The database the mirror lives in.
 */
export function resetRedactionCursorIn(
  db: Db,
  communityRef: CommunityRef,
  remoteRoomId: string
): void {
  db.update(communityRoomMirrors)
    .set({ redactionCursor: null })
    .where(
      and(
        eq(communityRoomMirrors.communityRef, communityRef),
        eq(communityRoomMirrors.remoteRoomId, remoteRoomId)
      )
    )
    .run();
}
