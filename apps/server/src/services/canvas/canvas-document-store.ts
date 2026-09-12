/**
 * Persistence for every canvas — rows in, rows out, and no rule of its own
 * (specs `room-canvas` §1 and `canvas-agent-seat` §1.2).
 *
 * **Keyed on SCOPE, never on a room.** One table serves a room's shared table
 * and one person's session canvas, and the scope is what tells them apart —
 * `room:<id>` or `session:<id>`. Every query here takes one, which is why the
 * indexes lead with it. Synchronous throughout (`better-sqlite3`), so applying
 * one canvas command is one transaction with no await inside it.
 *
 * Two things this module deliberately does NOT own. It never decides **who** may
 * write — that is conduct, and it lives in `CanvasService` and its room flavour.
 * And it never publishes: the stream is the service's, so a store that fanned
 * out would be a second place a canvas change could be announced from.
 *
 * @module server/services/canvas/canvas-document-store
 */
import {
  canvasDocuments,
  and,
  asc,
  desc,
  eq,
  isNull,
  like,
  sql,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { UiCanvasContentSchema, type UiCanvasContent } from '@dorkos/shared/schemas';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import { logger } from '../../lib/logger.js';

/** Everything a fresh row is written from. */
export interface CanvasDocumentInsert {
  id: string;
  scope: string;
  /** The room, or `null` for a `session:` row. See `roomIdForScope`. */
  roomId: string | null;
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
  /**
   * The room entry heading this document's discussion, or `null` for a document
   * nobody has opened one on (spec `canvas-agent-seat` §7).
   *
   * On the ROW rather than on the insert: a document is never created with a
   * thread. The column is written once, by the first Discuss, in the same
   * transaction as the entry it names.
   */
  threadRootEntryId: string | null;
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
  roomId: string | null;
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
  threadRootEntryId: string | null;
}): CanvasDocumentRow | null {
  const content = UiCanvasContentSchema.safeParse(row.content);
  if (!content.success) {
    logger.warn('[canvas] dropped a document whose content no longer parses', {
      scope: row.scope,
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
   * Every live document in one scope — pinned first, then most recently active.
   *
   * That is the order every reader sees: the tab strip, a room's context block,
   * `read_canvas`, and a session's cold snapshot. One ordering rule in one
   * place, so a person and an agent looking at the same table agree about what
   * is at the front of it.
   *
   * @param scope - The table — `room:<id>` or `session:<id>`.
   * @returns The scope's documents, pinned first then newest-active first.
   */
  list(scope: string): CanvasDocumentRow[] {
    return this.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.scope, scope))
      .orderBy(desc(canvasDocuments.pinned), desc(canvasDocuments.lastActiveAt))
      .all()
      .map(project)
      .filter((row): row is CanvasDocumentRow => row !== null);
  }

  /**
   * One document by id, scoped to its table.
   *
   * Scoped rather than looked up by the primary key alone: an id from another
   * room — or another person's session — must not resolve here, or a caller
   * holding one would be able to read a document out of a table that is not
   * theirs.
   *
   * @param scope - The table.
   * @param documentId - The document.
   * @returns The row, or `null`.
   */
  get(scope: string, documentId: string): CanvasDocumentRow | null {
    const row = this.db
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.scope, scope), eq(canvasDocuments.id, documentId)))
      .get();
    return row ? project(row) : null;
  }

  /**
   * The highest `rev` this scope has issued, or 0 when its canvas is empty.
   *
   * Monotonic per SCOPE rather than per document, so two frames for two
   * different documents still order against each other in a client that holds
   * both.
   *
   * @param scope - The table.
   * @returns The highest revision, or 0.
   */
  maxRev(scope: string): number {
    const row = this.db
      .select({ rev: sql<number>`coalesce(max(${canvasDocuments.rev}), 0)` })
      .from(canvasDocuments)
      .where(eq(canvasDocuments.scope, scope))
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
      .values({
        ...input,
        editingBy: null,
        editingHeartbeatAt: null,
        // A fresh document has no discussion. The column is the first Discuss's
        // to write, and only ever once.
        threadRootEntryId: null,
      })
      .run();
  }

  /**
   * Change an existing document's mutable columns.
   *
   * @param scope - The table.
   * @param documentId - The document.
   * @param patch - The columns to write.
   */
  update(
    scope: string,
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
      .where(and(eq(canvasDocuments.scope, scope), eq(canvasDocuments.id, documentId)))
      .run();
  }

  /**
   * Record which room entry heads this document's discussion (spec
   * `canvas-agent-seat` §7).
   *
   * **Takes the transaction rather than opening one**, because the entry and
   * this column have to land together: a thread root the log holds and the row
   * does not means the next Discuss starts a second thread, and a column
   * pointing at an entry that was never written is a tab that opens an empty
   * panel. The caller passes the transaction the entry is being appended in, so
   * both write or neither does.
   *
   * Written once. It is never cleared and never repointed: the thread a
   * document has is the thread it keeps.
   *
   * @param tx - The transaction the root entry is being written in.
   * @param scope - The table.
   * @param documentId - The document being discussed.
   * @param entryId - The entry heading the thread.
   */
  setThreadRoot(tx: DbTransaction, scope: string, documentId: string, entryId: string): void {
    tx.update(canvasDocuments)
      .set({ threadRootEntryId: entryId })
      .where(and(eq(canvasDocuments.scope, scope), eq(canvasDocuments.id, documentId)))
      .run();
  }

  /**
   * Remove one document.
   *
   * @param scope - The table.
   * @param documentId - The document.
   * @returns Whether a row was there to remove.
   */
  remove(scope: string, documentId: string): boolean {
    const result = this.db
      .delete(canvasDocuments)
      .where(and(eq(canvasDocuments.scope, scope), eq(canvasDocuments.id, documentId)))
      .run();
    return result.changes > 0;
  }

  /**
   * This author's own most recently opened-or-updated document in one scope.
   *
   * The honest default for a bare `update_canvas` or `close_canvas` (§5.6): it is
   * the only default that cannot act on somebody else's work by accident. Read
   * off the row rather than a process map, so it survives a restart mid
   * conversation.
   *
   * @param scope - The table.
   * @param authorId - The member asking.
   * @returns The document, or `null` when they have opened nothing here.
   */
  lastTouchedBy(scope: string, authorId: string): CanvasDocumentRow | null {
    const row = this.db
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.scope, scope), eq(canvasDocuments.lastTouchedBy, authorId)))
      .orderBy(desc(canvasDocuments.lastTouchedAt))
      .limit(1)
      .get();
    return row ? project(row) : null;
  }

  /**
   * Unpinned documents in one scope, least recently active first — the eviction
   * order.
   *
   * Pinned rows are excluded rather than sorted last, because they are not
   * candidates at all and are not counted against the capacity either.
   *
   * @param scope - The table.
   * @returns Unpinned documents, oldest-active first.
   */
  evictionCandidates(scope: string): CanvasDocumentRow[] {
    return this.db
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.scope, scope), eq(canvasDocuments.pinned, false)))
      .orderBy(asc(canvasDocuments.lastActiveAt))
      .all()
      .map(project)
      .filter((row): row is CanvasDocumentRow => row !== null);
  }

  /**
   * Every document in a scope that nobody has pinned, as a count.
   *
   * @param scope - The table.
   * @returns How many unpinned documents it holds.
   */
  unpinnedCount(scope: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.scope, scope), eq(canvasDocuments.pinned, false)))
      .get();
    return row?.n ?? 0;
  }

  /**
   * Find a document by its dedupe key within one scope.
   *
   * The `(scope, source_key)` unique index is what this reads, and it is why two
   * agents opening one file land on one row: the second open finds the first.
   *
   * @param scope - The table — `room:<id>` or `session:<id>`.
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
   * Documents in a scope with no dedupe key at all — `json` and `widget`.
   *
   * Exists so a test can say something about the one class of content the unique
   * index deliberately does not constrain.
   *
   * @param scope - The table.
   * @returns Every keyless document there.
   */
  keyless(scope: string): CanvasDocumentRow[] {
    return this.db
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.scope, scope), isNull(canvasDocuments.sourceKey)))
      .all()
      .map(project)
      .filter((row): row is CanvasDocumentRow => row !== null);
  }

  /**
   * Move every row of one scope to another, in ONE statement.
   *
   * What a canonical-id rekey needs (spec `canvas-agent-seat` §1.1): a
   * brand-new session's canvas is written under the request UUID the client
   * minted, and the SDK renames the session mid-first-turn. One statement inside
   * one implicit transaction means a concurrent reader sees every row under the
   * old scope or every row under the new one, never a split table.
   *
   * **It rewrites `scope` only, and leaves `id` alone.** A document id is a hash
   * of the scope it was opened under, so recomputing it would change every id
   * already handed to the model in this turn's tool results. The id is opaque,
   * the unique index is on `(scope, source_key)`, and that is still unique after
   * the rewrite — so re-opening the same source afterwards finds the same row
   * rather than inserting a second.
   *
   * @param from - The scope to move out of.
   * @param to - The scope to move into.
   * @returns How many rows moved. `0` is the common case and not an error.
   */
  rekeyScope(from: string, to: string): number {
    return this.db
      .update(canvasDocuments)
      .set({ scope: to })
      .where(eq(canvasDocuments.scope, from))
      .run().changes;
  }

  /**
   * Every distinct `session:` scope this table holds.
   *
   * Read by the orphan sweep, which has to know what is there before it can ask
   * which of it is still real (spec `canvas-agent-seat` §Data model 6).
   *
   * @returns The scope strings, unordered.
   */
  sessionScopes(): string[] {
    return this.db
      .selectDistinct({ scope: canvasDocuments.scope })
      .from(canvasDocuments)
      .where(like(canvasDocuments.scope, 'session:%'))
      .all()
      .map((row) => row.scope);
  }

  /**
   * Delete every row of one scope.
   *
   * The sweep's hand. A `room:` row is reclaimed by its room's `ON DELETE
   * cascade`; a `session:` row has nothing to hang off, because DorkOS has no
   * session deletion at all — only a runtime reporting one gone.
   *
   * @param scope - The table to empty.
   * @returns How many rows went.
   */
  removeScope(scope: string): number {
    return this.db.delete(canvasDocuments).where(eq(canvasDocuments.scope, scope)).run().changes;
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
    // Spread rather than sent as `null`, so a document nobody has discussed
    // renders exactly the shape it did before threads existed — and so a reader
    // asking "does this have a thread" asks one question rather than two.
    ...(row.threadRootEntryId !== null ? { threadRootEntryId: row.threadRootEntryId } : {}),
  };
}
