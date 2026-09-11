/**
 * Persistence for a room's shared canvas — rows in, rows out, and no rule of its
 * own (spec `room-canvas` §1).
 *
 * It sits beside {@link RoomStore} for the reason {@link ReactionStore} does:
 * this is a different key shape, a different ordering rule and a capacity rule
 * that has nothing to do with a room's log. Synchronous throughout, like every
 * other store in this domain (`better-sqlite3`), so applying one canvas command
 * is one transaction with no await inside it.
 *
 * Two things this module deliberately does NOT own. It never decides **who** may
 * write — that is conduct, and it lives in {@link RoomCanvasService}. And it
 * never publishes: the stream is the service's, so a store that fanned out would
 * be a second place a canvas change could be announced from.
 *
 * @module server/services/rooms/canvas/canvas-document-store
 */
import { canvasDocuments, and, asc, desc, eq, isNull, sql, type Db } from '@dorkos/db';
import { UiCanvasContentSchema, type UiCanvasContent } from '@dorkos/shared/schemas';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';

/** Everything a fresh row is written from. */
export interface CanvasDocumentInsert {
  id: string;
  scope: string;
  roomId: string;
  content: UiCanvasContent;
  title: string;
  contentType: string;
  authorId: string;
  sourceKey: string | null;
  sourceLabel: string | null;
  resolvedCwd: string | null;
  treeKind: 'room-main' | 'worktree' | 'agent-cwd' | null;
  aheadOfMain: number | null;
  pinned: boolean;
  rev: number;
  lastTouchedBy: string;
  lastTouchedAt: string;
  openedAt: string;
  lastActiveAt: string;
}

/** A row as the store holds it, before the service projects it for a reader. */
export interface CanvasDocumentRow extends CanvasDocumentInsert {
  editingBy: string | null;
  editingHeartbeatAt: string | null;
}

/**
 * Turn one database row into the shape a reader is handed.
 *
 * **The content is re-validated here rather than trusted.** It went in as JSON
 * and comes back as `unknown`, and a row written by an older build — or by a
 * variant that has since been removed from the union — must not be handed to a
 * client as if it parsed. A row whose content no longer validates is DROPPED
 * from the list with one log line, which degrades one document rather than a
 * room's whole canvas.
 *
 * @param row - The raw row.
 * @returns The projected document, or `null` when its content no longer parses.
 */
function project(row: {
  id: string;
  scope: string;
  roomId: string;
  content: unknown;
  title: string;
  contentType: string;
  authorId: string;
  sourceKey: string | null;
  sourceLabel: string | null;
  resolvedCwd: string | null;
  // A `text` column, so SQLite hands back any string. Narrowed below rather
  // than trusted: a row written by an older build carries whatever it carried.
  treeKind: string | null;
  aheadOfMain: number | null;
  pinned: boolean;
  rev: number;
  lastTouchedBy: string;
  lastTouchedAt: string;
  editingBy: string | null;
  editingHeartbeatAt: string | null;
  openedAt: string;
  lastActiveAt: string;
}): CanvasDocumentRow | null {
  const content = UiCanvasContentSchema.safeParse(row.content);
  if (!content.success) {
    logger.warn('[rooms] dropped a canvas document whose content no longer parses', {
      roomId: row.roomId,
      documentId: row.id,
      contentType: row.contentType,
    });
    return null;
  }
  return { ...row, content: content.data, treeKind: narrowTreeKind(row.treeKind) };
}

/** The three trees a file document can have been resolved against. */
const TREE_KINDS = new Set(['room-main', 'worktree', 'agent-cwd']);

/**
 * Read a stored tree kind back, or `null` for anything this build does not know.
 *
 * Narrowed rather than cast: the column is text, so a row written by a future
 * build — or by a hand-edited database — must degrade to "no label" rather than
 * reach a reader as a value the client cannot draw.
 *
 * @param stored - What the column held.
 * @returns The kind, or `null`.
 */
function narrowTreeKind(stored: string | null): CanvasDocumentRow['treeKind'] {
  return stored !== null && TREE_KINDS.has(stored)
    ? (stored as CanvasDocumentRow['treeKind'])
    : null;
}

/** Reads and writes over `canvas_documents`. */
export class CanvasDocumentStore {
  /**
   * Bind the store to one install's database.
   *
   * @param db - The consolidated DB handle.
   */
  constructor(private readonly db: Db) {}

  /**
   * Every live document in one room — pinned first, then most recently active.
   *
   * That is the order every reader sees: the tab strip, the room context block,
   * and `read_canvas`. One ordering rule in one place, so a person and an agent
   * looking at the same room agree about what is at the front of it.
   *
   * @param roomId - The room.
   * @returns The room's documents, pinned first then newest-active first.
   */
  list(roomId: string): CanvasDocumentRow[] {
    return this.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.roomId, roomId))
      .orderBy(desc(canvasDocuments.pinned), desc(canvasDocuments.lastActiveAt))
      .all()
      .map(project)
      .filter((row): row is CanvasDocumentRow => row !== null);
  }

  /**
   * One document by id, scoped to its room.
   *
   * Scoped rather than looked up by the primary key alone: an id from another
   * room must not resolve here, or a caller holding one would be able to read a
   * document out of a room they are not in.
   *
   * @param roomId - The room.
   * @param documentId - The document.
   * @returns The row, or `null`.
   */
  get(roomId: string, documentId: string): CanvasDocumentRow | null {
    const row = this.db
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.roomId, roomId), eq(canvasDocuments.id, documentId)))
      .get();
    return row ? project(row) : null;
  }

  /**
   * The highest `rev` this room has issued, or 0 when its canvas is empty.
   *
   * Monotonic per ROOM rather than per document, so two frames for two different
   * documents still order against each other in a client that holds both.
   *
   * @param roomId - The room.
   * @returns The highest revision, or 0.
   */
  maxRev(roomId: string): number {
    const row = this.db
      .select({ rev: sql<number>`coalesce(max(${canvasDocuments.rev}), 0)` })
      .from(canvasDocuments)
      .where(eq(canvasDocuments.roomId, roomId))
      .get();
    return row?.rev ?? 0;
  }

  /**
   * Insert a fresh document.
   *
   * @param input - Everything the row is written from.
   */
  insert(input: CanvasDocumentInsert): void {
    this.db
      .insert(canvasDocuments)
      .values({ ...input, editingBy: null, editingHeartbeatAt: null })
      .run();
  }

  /**
   * Change an existing document's mutable columns.
   *
   * @param roomId - The room.
   * @param documentId - The document.
   * @param patch - The columns to write.
   */
  update(
    roomId: string,
    documentId: string,
    patch: Partial<{
      content: UiCanvasContent;
      title: string;
      contentType: string;
      sourceLabel: string | null;
      resolvedCwd: string | null;
      treeKind: 'room-main' | 'worktree' | 'agent-cwd' | null;
      aheadOfMain: number | null;
      pinned: boolean;
      rev: number;
      lastTouchedBy: string;
      lastTouchedAt: string;
      editingBy: string | null;
      editingHeartbeatAt: string | null;
      lastActiveAt: string;
    }>
  ): void {
    this.db
      .update(canvasDocuments)
      .set(patch)
      .where(and(eq(canvasDocuments.roomId, roomId), eq(canvasDocuments.id, documentId)))
      .run();
  }

  /**
   * Remove one document.
   *
   * @param roomId - The room.
   * @param documentId - The document.
   * @returns Whether a row was there to remove.
   */
  remove(roomId: string, documentId: string): boolean {
    const result = this.db
      .delete(canvasDocuments)
      .where(and(eq(canvasDocuments.roomId, roomId), eq(canvasDocuments.id, documentId)))
      .run();
    return result.changes > 0;
  }

  /**
   * This author's own most recently opened-or-updated document in one room.
   *
   * The honest default for a bare `update_canvas` or `close_canvas` (§5.6): it is
   * the only default that cannot act on somebody else's work by accident. Read
   * off the row rather than a process map, so it survives a restart mid
   * conversation.
   *
   * @param roomId - The room.
   * @param authorId - The member asking.
   * @returns The document, or `null` when they have opened nothing here.
   */
  lastTouchedBy(roomId: string, authorId: string): CanvasDocumentRow | null {
    const row = this.db
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.roomId, roomId), eq(canvasDocuments.lastTouchedBy, authorId)))
      .orderBy(desc(canvasDocuments.lastTouchedAt))
      .limit(1)
      .get();
    return row ? project(row) : null;
  }

  /**
   * Unpinned documents in one room, least recently active first — the eviction
   * order.
   *
   * Pinned rows are excluded rather than sorted last, because they are not
   * candidates at all and are not counted against the capacity either.
   *
   * @param roomId - The room.
   * @returns Unpinned documents, oldest-active first.
   */
  evictionCandidates(roomId: string): CanvasDocumentRow[] {
    return this.db
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.roomId, roomId), eq(canvasDocuments.pinned, false)))
      .orderBy(asc(canvasDocuments.lastActiveAt))
      .all()
      .map(project)
      .filter((row): row is CanvasDocumentRow => row !== null);
  }

  /**
   * Every document in a room that nobody has pinned, as a count.
   *
   * @param roomId - The room.
   * @returns How many unpinned documents the room holds.
   */
  unpinnedCount(roomId: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.roomId, roomId), eq(canvasDocuments.pinned, false)))
      .get();
    return row?.n ?? 0;
  }

  /**
   * Find a document by its dedupe key within one scope.
   *
   * The `(scope, source_key)` unique index is what this reads, and it is why two
   * agents opening one file land on one row: the second open finds the first.
   *
   * @param scope - The table — `room:<roomId>`.
   * @param sourceKey - The dedupe key. A `null` key matches nothing by design.
   * @returns The row, or `null`.
   */
  findBySourceKey(scope: string, sourceKey: string | null): CanvasDocumentRow | null {
    if (sourceKey === null) return null;
    const row = this.db
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.scope, scope), eq(canvasDocuments.sourceKey, sourceKey)))
      .get();
    return row ? project(row) : null;
  }

  /**
   * Documents in a room with no dedupe key at all — `json` and `widget`.
   *
   * Exists so a test can say something about the one class of content the unique
   * index deliberately does not constrain.
   *
   * @param roomId - The room.
   * @returns Every keyless document there.
   */
  keyless(roomId: string): CanvasDocumentRow[] {
    return this.db
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.roomId, roomId), isNull(canvasDocuments.sourceKey)))
      .all()
      .map(project)
      .filter((row): row is CanvasDocumentRow => row !== null);
  }
}

/**
 * Project one stored row into the shape the wire carries.
 *
 * The edit lock is resolved against its TTL HERE rather than stored resolved: a
 * lock is live only while its heartbeat is recent, evaluated lazily at read time
 * so a crashed browser simply stops holding one rather than wedging a document
 * for ever.
 *
 * @param row - The stored row.
 * @param now - The instant to judge the lock against.
 * @param ttlMs - How long a heartbeat keeps a lock live.
 * @returns The document as a reader receives it.
 */
export function toCanvasDocument(
  row: CanvasDocumentRow,
  now: number,
  ttlMs: number
): CanvasDocument {
  const heldAt = row.editingHeartbeatAt ? Date.parse(row.editingHeartbeatAt) : NaN;
  const live = row.editingBy !== null && Number.isFinite(heldAt) && now - heldAt < ttlMs;
  return {
    id: row.id,
    scope: row.scope,
    roomId: row.roomId,
    content: row.content,
    title: row.title,
    contentType: row.contentType,
    authorId: row.authorId,
    pinned: row.pinned,
    rev: row.rev,
    lastTouchedBy: row.lastTouchedBy,
    lastTouchedAt: row.lastTouchedAt,
    ...(live && row.editingBy !== null ? { editingBy: row.editingBy } : {}),
    ...(row.sourceLabel !== null ? { sourceLabel: row.sourceLabel } : {}),
    // Both together or neither: `aheadOfMain` is a fact ABOUT a tree, and a
    // count with no tree to attach it to is a number nobody can place. `null`
    // travels on purpose — it means "not measured", which is a different claim
    // from "level with the room" and must not collapse into it.
    ...(row.treeKind !== null ? { treeKind: row.treeKind, aheadOfMain: row.aheadOfMain } : {}),
    openedAt: row.openedAt,
    lastActiveAt: row.lastActiveAt,
  };
}
