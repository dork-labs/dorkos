/**
 * Persistence for the rows behind a room's attachments (spec
 * `room-attachments` §Data model).
 *
 * It sits beside {@link RoomStore} for the reason {@link ReactionStore} does:
 * the same key shape, a different lifecycle, and nothing to do with a room's
 * log. Synchronous throughout, like every other store here
 * (`better-sqlite3`), which is what lets {@link AttachmentRowStore.bind} run
 * inside the entry's own transaction.
 *
 * Two things it deliberately does NOT own. It never decides **who** may attach
 * a file or whether an id may be posted — that is conduct, and it lives in
 * `RoomService.resolveAttachments`. And it never builds a URL: `url` is
 * whatever `RoomAttachmentStore.put` answered, carried through untouched, so
 * the day a room's bytes live somewhere other than this machine no code here
 * changes.
 *
 * @module server/services/rooms/attachments/attachment-row-store
 */
import { roomAttachments, and, eq, inArray, isNull, type Db, type DbTransaction } from '@dorkos/db';
import type { RoomAttachment, RoomAttachmentPreview } from '@dorkos/shared/room-schemas';

/** One `room_attachments` row, as this module hands it around. */
export interface AttachmentRow {
  roomId: string;
  id: string;
  /** The entry it was posted with, or `null` while it is uploaded and unposted. */
  entryId: string | null;
  authorId: string;
  name: string;
  /** The suffix the bytes are stored under, without a dot. May be `''`. */
  extension: string;
  mimeType: string;
  size: number;
  /** `'image'` only when the BYTES were verified previewable. */
  preview: RoomAttachmentPreview | null;
  url: string;
  createdAt: string;
}

/** What {@link AttachmentRowStore.create} needs; the rest it stamps itself. */
export type NewAttachmentRow = Omit<AttachmentRow, 'entryId' | 'createdAt'>;

/**
 * The one place a row becomes the shape a reader sees.
 *
 * `url` comes off the row rather than being rebuilt from the ids, which is the
 * whole reason the column exists — see the schema's own note.
 *
 * @param row - The stored row.
 */
function toWire(row: AttachmentRow): RoomAttachment {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    preview: row.preview,
    url: row.url,
  };
}

/** Reads and writes over `room_attachments`. */
export class AttachmentRowStore {
  constructor(private readonly db: Db) {}

  /**
   * Record a file that has been stored but not yet posted.
   *
   * @param row - Everything the upload settled: ids, the sanitized name, the
   *   type the bytes were judged to be, and the URL the store answered.
   * @param createdAt - When it landed, ISO 8601.
   */
  create(row: NewAttachmentRow, createdAt: string): void {
    this.db
      .insert(roomAttachments)
      .values({ ...row, entryId: null, createdAt })
      .run();
  }

  /**
   * The unbound rows among these ids, for the resolution that runs before a
   * post is written.
   *
   * Scoped to the room AND to `entry_id IS NULL`, so an id from another room
   * and an id already posted are both simply absent — the caller tells those
   * two apart by asking {@link AttachmentRowStore.get}, and refuses each with
   * its own code.
   *
   * @param roomId - The room the post is being written in.
   * @param attachmentIds - The ids the post named. An empty list reads nothing.
   */
  listUnboundFor(roomId: string, attachmentIds: readonly string[]): AttachmentRow[] {
    const wanted = [...new Set(attachmentIds)];
    if (wanted.length === 0) return [];
    return this.db
      .select()
      .from(roomAttachments)
      .where(
        and(
          eq(roomAttachments.roomId, roomId),
          isNull(roomAttachments.entryId),
          inArray(roomAttachments.id, wanted)
        )
      )
      .all()
      .map(toRow);
  }

  /**
   * One row, whatever state it is in — what the serve route reads.
   *
   * @param roomId - The room.
   * @param attachmentId - The attachment id.
   */
  get(roomId: string, attachmentId: string): AttachmentRow | null {
    const row = this.db
      .select()
      .from(roomAttachments)
      .where(and(eq(roomAttachments.roomId, roomId), eq(roomAttachments.id, attachmentId)))
      .get();
    return row ? toRow(row) : null;
  }

  /**
   * Point these attachments at the entry that carries them.
   *
   * **Runs inside the entry's own transaction, on the far side of the insert**
   * ({@link RoomStore.appendEntry}'s `bind` hook). The composite foreign key is
   * checked at statement time, so this cannot run before the parent row exists
   * — which is exactly why that hook was added. The `entry_id IS NULL` guard is
   * belt-and-braces over the resolution that already refused a posted id: it
   * makes double-binding impossible even if two posts raced past resolution,
   * and the caller checks the row count to notice.
   *
   * @param roomId - The room.
   * @param attachmentIds - The ids to bind, already resolved.
   * @param entryId - The entry they were posted with.
   * @param tx - The entry's transaction.
   * @returns How many rows were bound; anything short of the id count means a
   *   race took one first.
   */
  bind(
    roomId: string,
    attachmentIds: readonly string[],
    entryId: string,
    tx: DbTransaction
  ): number {
    if (attachmentIds.length === 0) return 0;
    return tx
      .update(roomAttachments)
      .set({ entryId })
      .where(
        and(
          eq(roomAttachments.roomId, roomId),
          isNull(roomAttachments.entryId),
          inArray(roomAttachments.id, [...attachmentIds])
        )
      )
      .run().changes;
  }

  /**
   * The attachments on several entries at once, grouped by entry.
   *
   * Batched for the reason {@link ReactionStore.listFor} is: a page of fifty
   * entries would otherwise be fifty round trips. Both readers take this — the
   * history page and the hydration snapshot — so there is one query shape and
   * one ordering rule rather than two that could drift.
   *
   * **Ordered by when each file landed, then by id.** Upload order is the order
   * a person dropped their files in, and it is what the composer showed them;
   * the id breaks a tie inside one millisecond, which two files selected in one
   * dialog genuinely share, so two installs holding identical rows render
   * identical rows.
   *
   * @param roomId - The room the entries live in.
   * @param entryIds - The entries to read. An empty list reads nothing.
   * @returns One list per entry that HAS attachments; an entry with none is absent.
   */
  listFor(roomId: string, entryIds: readonly string[]): Map<string, RoomAttachment[]> {
    const grouped = new Map<string, RoomAttachment[]>();
    const wanted = [...new Set(entryIds)];
    if (wanted.length === 0) return grouped;
    const rows = this.db
      .select()
      .from(roomAttachments)
      .where(and(eq(roomAttachments.roomId, roomId), inArray(roomAttachments.entryId, wanted)))
      .orderBy(roomAttachments.entryId, roomAttachments.createdAt, roomAttachments.id)
      .all();

    for (const row of rows) {
      // `entryId` is non-null by the `inArray` above; the column's type does not
      // know that.
      const entryId = row.entryId;
      if (entryId === null) continue;
      let files = grouped.get(entryId);
      if (!files) {
        files = [];
        grouped.set(entryId, files);
      }
      files.push(toWire(toRow(row)));
    }
    return grouped;
  }

  /**
   * One entry's attachments — what a freshly published entry carries.
   *
   * @param roomId - The room.
   * @param entryId - The entry.
   */
  listForEntry(roomId: string, entryId: string): RoomAttachment[] {
    return this.listFor(roomId, [entryId]).get(entryId) ?? [];
  }

  /**
   * Forget every attachment row a room holds — the row half of
   * {@link RoomAttachmentStore.deleteRoom}. Idempotent.
   *
   * @param roomId - The room to clear.
   */
  deleteRoom(roomId: string): void {
    this.db.delete(roomAttachments).where(eq(roomAttachments.roomId, roomId)).run();
  }
}

/** Narrow a stored row's loose text columns onto the domain shape. */
function toRow(row: typeof roomAttachments.$inferSelect): AttachmentRow {
  return {
    ...row,
    // The column is plain text, so the one legal non-null value is asserted
    // here rather than trusted everywhere downstream.
    preview: row.preview === 'image' ? 'image' : null,
  };
}
