/**
 * The server's record of what chats sent each other (spec `spin-off-chats`,
 * ADR 261009-171114), kept in `chat_messages`, `chat_agent_dms` and
 * `chat_read_cursors`.
 *
 * Synchronous (better-sqlite3), like the queue store beside it: the stamp that
 * puts a sender on a received message runs on every history read and every
 * live `turn_start`, and the dispatcher's launch reads a queued row's ceiling
 * from here in the same beat it starts the turn.
 *
 * @module services/session/chat-messages/chat-message-store
 */
import {
  and,
  asc,
  chatAgentDms,
  chatMessages,
  chatReadCursors,
  desc,
  eq,
  inArray,
  or,
  type ChatMessageRow,
  type Db,
} from '@dorkos/db';
import type {
  ChatDelivery,
  ChatMessageKind,
  ChatMessageStatus,
} from '@dorkos/shared/chat-messages';

/** A chat message as the store writes it. */
export interface NewChatMessage {
  /** The receipt id. */
  id: string;
  /** The receiving chat. */
  toSessionId: string;
  /** The sending chat. */
  fromSessionId: string;
  /** The sending agent's home. */
  fromAgentPath: string;
  /** The sending agent's Mesh id, or null. */
  fromAgentId: string | null;
  /** The sending agent's name. */
  fromAgentName: string;
  /** The sending chat's title, or null. */
  fromChatTitle: string | null;
  /** What it is. */
  kind: ChatMessageKind;
  /** The words. */
  text: string;
  /** The one-line label, or null. */
  summary: string | null;
  /** The fence nonce, or null for a stop. */
  nonce: string | null;
  /** How it was asked to arrive. */
  delivery: ChatDelivery;
  /** Where it starts. */
  status: ChatMessageStatus;
  /** The dispatcher's message id, or null. */
  queueMessageId: string | null;
  /** The ceiling, as JSON. */
  ceilingJson: string;
  /** The chat message this answers, or null. */
  replyToId: string | null;
}

/** What may change on a chat message after it is written. */
export type ChatMessagePatch = Partial<
  Pick<ChatMessageRow, 'status' | 'failureReason' | 'queueMessageId' | 'toSessionId' | 'replyToId'>
>;

/** Most ids one batched read asks SQLite for at once, well under its variable limit. */
const BATCH = 500;

/** Reads and writes the chat-message tables. */
export class ChatMessageStore {
  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   * @param now - The clock (tests pin it).
   */
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Write a new chat message.
   *
   * @param input - The row.
   */
  insert(input: NewChatMessage): ChatMessageRow {
    const at = this.now().toISOString();
    const row: ChatMessageRow = {
      ...input,
      failureReason: null,
      createdAt: at,
      updatedAt: at,
    };
    this.db.insert(chatMessages).values(row).run();
    return row;
  }

  /**
   * One chat message by id.
   *
   * @param id - The receipt id.
   */
  get(id: string): ChatMessageRow | undefined {
    return this.db.select().from(chatMessages).where(eq(chatMessages.id, id)).get();
  }

  /**
   * Several chat messages by id, in no particular order.
   *
   * @param ids - Receipt ids.
   */
  getMany(ids: readonly string[]): ChatMessageRow[] {
    const out: ChatMessageRow[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      if (chunk.length === 0) continue;
      out.push(...this.db.select().from(chatMessages).where(inArray(chatMessages.id, chunk)).all());
    }
    return out;
  }

  /**
   * Change a chat message. Writes nothing when the patch is empty.
   *
   * @param id - The receipt id.
   * @param patch - What changes.
   */
  update(id: string, patch: ChatMessagePatch): ChatMessageRow | undefined {
    if (Object.keys(patch).length === 0) return this.get(id);
    this.db
      .update(chatMessages)
      .set({ ...patch, updatedAt: this.now().toISOString() })
      .where(eq(chatMessages.id, id))
      .run();
    return this.get(id);
  }

  /**
   * Remove a chat message that was never delivered (a refused send), so the
   * stamp never names a send that did not happen.
   *
   * @param id - The receipt id.
   */
  delete(id: string): void {
    this.db.delete(chatMessages).where(eq(chatMessages.id, id)).run();
  }

  /**
   * The messages a chat received under these fence nonces: the only way a
   * sender is put on a message the app shows.
   *
   * @param toSessionId - The receiving chat, in any id it answers to.
   * @param nonces - The nonces found in its user messages.
   */
  findByNonces(toSessionIds: readonly string[], nonces: readonly string[]): ChatMessageRow[] {
    if (nonces.length === 0 || toSessionIds.length === 0) return [];
    const out: ChatMessageRow[] = [];
    for (let i = 0; i < nonces.length; i += BATCH) {
      const chunk = nonces.slice(i, i + BATCH);
      out.push(
        ...this.db
          .select()
          .from(chatMessages)
          .where(
            and(
              inArray(chatMessages.toSessionId, [...toSessionIds]),
              inArray(chatMessages.nonce, chunk)
            )
          )
          .all()
      );
    }
    return out;
  }

  /**
   * Every chat message waiting in one dispatcher queue row: one, or several
   * when agent messages that waited together were batched into one turn.
   *
   * @param queueMessageId - The dispatcher's message id.
   */
  listByQueueMessage(queueMessageId: string): ChatMessageRow[] {
    return this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.queueMessageId, queueMessageId))
      .orderBy(asc(chatMessages.createdAt))
      .all();
  }

  /**
   * What a chat sent: the Sent cards it draws.
   *
   * @param fromSessionId - The sending chat.
   */
  listSentFrom(fromSessionId: string): ChatMessageRow[] {
    return this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.fromSessionId, fromSessionId))
      .orderBy(asc(chatMessages.createdAt))
      .all();
  }

  /**
   * The stops other chats made on this chat: the "Stopped by" lines it shows.
   *
   * @param toSessionId - The stopped chat.
   */
  listStopsOf(toSessionId: string): ChatMessageRow[] {
    return this.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.toSessionId, toSessionId), eq(chatMessages.kind, 'stop')))
      .orderBy(asc(chatMessages.createdAt))
      .all();
  }

  /**
   * The newest message one chat sent another that is not answered yet, so a
   * message going back can be threaded to it.
   *
   * @param fromSessionId - The chat that sent it.
   * @param toSessionId - The chat it went to.
   */
  latestUnanswered(fromSessionId: string, toSessionId: string): ChatMessageRow | undefined {
    return this.db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.fromSessionId, fromSessionId),
          eq(chatMessages.toSessionId, toSessionId),
          inArray(chatMessages.kind, ['message', 'start']),
          inArray(chatMessages.status, ['queued', 'working', 'delivered', 'steered', 'interrupted'])
        )
      )
      .orderBy(desc(chatMessages.createdAt))
      .get();
  }

  /**
   * Every chat a chat has exchanged messages with, either way.
   *
   * @param sessionId - The chat.
   */
  correspondentsOf(sessionId: string): Set<string> {
    const rows = this.db
      .select({ from: chatMessages.fromSessionId, to: chatMessages.toSessionId })
      .from(chatMessages)
      .where(or(eq(chatMessages.fromSessionId, sessionId), eq(chatMessages.toSessionId, sessionId)))
      .all();
    const out = new Set<string>();
    for (const row of rows) out.add(row.from === sessionId ? row.to : row.from);
    out.delete(sessionId);
    return out;
  }

  /**
   * The DM chat one agent keeps with another, or undefined.
   *
   * @param fromAgentPath - The sending agent's home.
   * @param toAgentId - The receiving agent's Mesh id.
   */
  dmChat(fromAgentPath: string, toAgentId: string): string | undefined {
    return this.db
      .select({ sessionId: chatAgentDms.sessionId })
      .from(chatAgentDms)
      .where(
        and(eq(chatAgentDms.fromAgentPath, fromAgentPath), eq(chatAgentDms.toAgentId, toAgentId))
      )
      .get()?.sessionId;
  }

  /**
   * Keep (or replace) the DM chat one agent keeps with another.
   *
   * @param fromAgentPath - The sending agent's home.
   * @param toAgentId - The receiving agent's Mesh id.
   * @param sessionId - The chat.
   */
  keepDmChat(fromAgentPath: string, toAgentId: string, sessionId: string): void {
    this.db
      .insert(chatAgentDms)
      .values({ fromAgentPath, toAgentId, sessionId, createdAt: this.now().toISOString() })
      .onConflictDoUpdate({
        target: [chatAgentDms.fromAgentPath, chatAgentDms.toAgentId],
        set: { sessionId },
      })
      .run();
  }

  /**
   * How far one chat has read another, or undefined when it never has.
   *
   * @param readerSessionId - The reading chat.
   * @param targetSessionId - The chat it read.
   */
  readCursor(readerSessionId: string, targetSessionId: string): string | undefined {
    return this.db
      .select({ lastMessageId: chatReadCursors.lastMessageId })
      .from(chatReadCursors)
      .where(
        and(
          eq(chatReadCursors.readerSessionId, readerSessionId),
          eq(chatReadCursors.targetSessionId, targetSessionId)
        )
      )
      .get()?.lastMessageId;
  }

  /**
   * Record how far one chat has read another.
   *
   * @param readerSessionId - The reading chat.
   * @param targetSessionId - The chat it read.
   * @param lastMessageId - The newest message it was given.
   */
  setReadCursor(readerSessionId: string, targetSessionId: string, lastMessageId: string): void {
    const readAt = this.now().toISOString();
    this.db
      .insert(chatReadCursors)
      .values({ readerSessionId, targetSessionId, lastMessageId, readAt })
      .onConflictDoUpdate({
        target: [chatReadCursors.readerSessionId, chatReadCursors.targetSessionId],
        set: { lastMessageId, readAt },
      })
      .run();
  }

  /**
   * Move every row that names a chat to the id the runtime renamed it to.
   * Idempotent: a second call on the same move finds nothing to move.
   *
   * @param fromId - The id the chat was known by.
   * @param toId - The id it is known by now.
   */
  rekeySession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db.transaction((tx) => {
      tx.update(chatMessages)
        .set({ toSessionId: toId })
        .where(eq(chatMessages.toSessionId, fromId))
        .run();
      tx.update(chatMessages)
        .set({ fromSessionId: toId })
        .where(eq(chatMessages.fromSessionId, fromId))
        .run();
      tx.update(chatAgentDms)
        .set({ sessionId: toId })
        .where(eq(chatAgentDms.sessionId, fromId))
        .run();
      // A cursor already at the new id wins; the old one is dropped.
      const held = tx
        .select()
        .from(chatReadCursors)
        .where(
          or(
            eq(chatReadCursors.readerSessionId, fromId),
            eq(chatReadCursors.targetSessionId, fromId)
          )
        )
        .all();
      for (const row of held) {
        tx.delete(chatReadCursors)
          .where(
            and(
              eq(chatReadCursors.readerSessionId, row.readerSessionId),
              eq(chatReadCursors.targetSessionId, row.targetSessionId)
            )
          )
          .run();
        tx.insert(chatReadCursors)
          .values({
            ...row,
            readerSessionId: row.readerSessionId === fromId ? toId : row.readerSessionId,
            targetSessionId: row.targetSessionId === fromId ? toId : row.targetSessionId,
          })
          .onConflictDoNothing()
          .run();
      }
    });
  }
}

let shared: ChatMessageStore | undefined;

/**
 * Wire the store at boot (or clear it in a test).
 *
 * @param store - The store, or undefined.
 */
export function setChatMessageStore(store: ChatMessageStore | undefined): void {
  shared = store;
}

/** The wired store, or undefined before boot. */
export function getChatMessageStore(): ChatMessageStore | undefined {
  return shared;
}
