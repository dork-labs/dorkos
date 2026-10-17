/**
 * What DorkOS remembers about comments on docs (DOR-2983): threads, their
 * comments, and the chat it keeps with each agent a comment mentions.
 *
 * Deliberately dumb. A thread's anchor is the editor's opaque JSON, stored and
 * handed back; nothing here reads inside it, decides who may write, or
 * resolves a mention. `comment-service.ts` does all of that.
 *
 * Every method is synchronous (better-sqlite3).
 *
 * @module services/docs/comments/comment-store
 */
import {
  and,
  asc,
  count,
  docCommentAgentChats,
  docComments,
  docCommentThreads,
  eq,
  inArray,
  type Db,
  type DocCommentRow,
  type DocCommentThreadRow,
} from '@dorkos/db';

/** A thread as the store writes it. */
export type NewDocCommentThread = Omit<
  DocCommentThreadRow,
  'resolved' | 'resolvedAt' | 'resolvedByAuthorId' | 'updatedAt'
>;

/** A comment as the store writes it. */
export type NewDocComment = Omit<DocCommentRow, 'editedAt'>;

/** A thread with its comments, oldest first. */
export interface StoredDocCommentThread {
  /** The thread row. */
  thread: DocCommentThreadRow;
  /** Its comments, oldest first. */
  comments: DocCommentRow[];
}

/** Reads and writes `doc_comment_threads`, `doc_comments` and `doc_comment_agent_chats`. */
export class DocCommentStore {
  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   */
  constructor(private readonly db: Db) {}

  /**
   * Every thread on one doc with its comments, oldest first.
   *
   * @param docKey - The doc's key (`docKey(space, path)`).
   */
  listThreads(docKey: string): StoredDocCommentThread[] {
    const threads = this.db
      .select()
      .from(docCommentThreads)
      .where(eq(docCommentThreads.docKey, docKey))
      .orderBy(asc(docCommentThreads.createdAt), asc(docCommentThreads.id))
      .all();
    if (threads.length === 0) return [];
    const comments = this.db
      .select()
      .from(docComments)
      .where(
        inArray(
          docComments.threadId,
          threads.map((thread) => thread.id)
        )
      )
      .orderBy(asc(docComments.createdAt), asc(docComments.id))
      .all();
    const byThread = new Map<string, DocCommentRow[]>();
    for (const comment of comments) {
      const list = byThread.get(comment.threadId) ?? [];
      list.push(comment);
      byThread.set(comment.threadId, list);
    }
    return threads.map((thread) => ({ thread, comments: byThread.get(thread.id) ?? [] }));
  }

  /**
   * One thread with its comments, when it is on this doc.
   *
   * @param docKey - The doc the caller named; a thread on another doc is not found.
   * @param threadId - The thread.
   */
  getThread(docKey: string, threadId: string): StoredDocCommentThread | null {
    const thread = this.db
      .select()
      .from(docCommentThreads)
      .where(and(eq(docCommentThreads.id, threadId), eq(docCommentThreads.docKey, docKey)))
      .get();
    if (!thread) return null;
    const comments = this.db
      .select()
      .from(docComments)
      .where(eq(docComments.threadId, threadId))
      .orderBy(asc(docComments.createdAt), asc(docComments.id))
      .all();
    return { thread, comments };
  }

  /**
   * Open a thread with its first comment, both or neither.
   *
   * @param thread - The thread.
   * @param first - Its first comment.
   */
  insertThread(thread: NewDocCommentThread, first: NewDocComment): StoredDocCommentThread {
    return this.db.transaction((tx) => {
      const row = tx
        .insert(docCommentThreads)
        .values({ ...thread, updatedAt: thread.createdAt })
        .returning()
        .get();
      const comment = tx.insert(docComments).values(first).returning().get();
      return { thread: row, comments: [comment] };
    });
  }

  /**
   * Add a comment to a thread, and mark the thread changed.
   *
   * @param comment - The comment.
   */
  insertComment(comment: NewDocComment): DocCommentRow {
    return this.db.transaction((tx) => {
      const row = tx.insert(docComments).values(comment).returning().get();
      tx.update(docCommentThreads)
        .set({ updatedAt: comment.createdAt })
        .where(eq(docCommentThreads.id, comment.threadId))
        .run();
      return row;
    });
  }

  /**
   * One comment, when it is in this thread.
   *
   * @param threadId - The thread.
   * @param commentId - The comment.
   */
  getComment(threadId: string, commentId: string): DocCommentRow | null {
    return (
      this.db
        .select()
        .from(docComments)
        .where(and(eq(docComments.id, commentId), eq(docComments.threadId, threadId)))
        .get() ?? null
    );
  }

  /**
   * Change a comment's words.
   *
   * @param comment - The comment as it stands.
   * @param body - Its new words.
   * @param at - When (ISO 8601).
   */
  editComment(comment: DocCommentRow, body: string, at: string): DocCommentRow {
    return this.db.transaction((tx) => {
      const row = tx
        .update(docComments)
        .set({ body, editedAt: at })
        .where(eq(docComments.id, comment.id))
        .returning()
        .get();
      tx.update(docCommentThreads)
        .set({ updatedAt: at })
        .where(eq(docCommentThreads.id, comment.threadId))
        .run();
      return row;
    });
  }

  /**
   * Mark a thread done, or open it again.
   *
   * @param threadId - The thread.
   * @param resolved - `true` to mark it done.
   * @param authorId - Who did it.
   * @param at - When (ISO 8601).
   */
  setResolved(threadId: string, resolved: boolean, authorId: string, at: string): void {
    this.db
      .update(docCommentThreads)
      .set({
        resolved,
        resolvedAt: resolved ? at : null,
        resolvedByAuthorId: resolved ? authorId : null,
        updatedAt: at,
      })
      .where(eq(docCommentThreads.id, threadId))
      .run();
  }

  /**
   * Save fresh anchors for threads on one doc, in one transaction. An id that
   * is not a thread on this doc is skipped, so a stale editor cannot move a
   * thread on another doc.
   *
   * @param docKey - The doc.
   * @param updates - Each thread and its new anchor (JSON).
   * @returns How many threads took a new anchor.
   */
  updateAnchors(
    docKey: string,
    updates: ReadonlyArray<{ id: string; anchorJson: string }>
  ): number {
    if (updates.length === 0) return 0;
    return this.db.transaction((tx) => {
      let updated = 0;
      for (const { id, anchorJson } of updates) {
        const result = tx
          .update(docCommentThreads)
          .set({ anchorJson })
          .where(and(eq(docCommentThreads.id, id), eq(docCommentThreads.docKey, docKey)))
          .run();
        updated += result.changes;
      }
      return updated;
    });
  }

  /**
   * How many comments each author wrote in one chain of automatic replies:
   * the per-author count the cascade guard's repeat rule reads.
   *
   * Comments, not turns: a woken agent that writes two comments in one turn
   * spends two. Stricter than the room count (which collapses one turn's
   * entries), and a doc chain is short.
   *
   * @param cascadeRoot - The comment that began the chain.
   */
  commentsByAuthorInCascade(cascadeRoot: string): Map<string, number> {
    const rows = this.db
      .select({ authorId: docComments.authorId, n: count() })
      .from(docComments)
      .where(eq(docComments.cascadeRoot, cascadeRoot))
      .groupBy(docComments.authorId)
      .all();
    return new Map(rows.map((row) => [row.authorId, row.n]));
  }

  /**
   * The chat kept with an agent for doc comments, or null before the first.
   *
   * @param agentId - The Mesh agent id.
   */
  keptChat(agentId: string): string | null {
    return (
      this.db
        .select({ sessionId: docCommentAgentChats.sessionId })
        .from(docCommentAgentChats)
        .where(eq(docCommentAgentChats.agentId, agentId))
        .get()?.sessionId ?? null
    );
  }

  /**
   * Remember the chat kept with an agent, replacing any earlier one.
   *
   * @param agentId - The Mesh agent id.
   * @param sessionId - The chat (canonical id).
   * @param at - When (ISO 8601).
   */
  keepChat(agentId: string, sessionId: string, at: string): void {
    this.db
      .insert(docCommentAgentChats)
      .values({ agentId, sessionId, createdAt: at })
      .onConflictDoUpdate({
        target: docCommentAgentChats.agentId,
        set: { sessionId, createdAt: at },
      })
      .run();
  }
}
