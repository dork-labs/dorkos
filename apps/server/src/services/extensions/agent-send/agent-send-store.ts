/**
 * What `ctx.agent.send` remembers (DOR-2683): every message an extension sent,
 * by its id and by its idempotency key, and the chat each extension keeps with
 * each agent it messages. Both live in SQLite so a restart forgets neither: a
 * resend after a crash still answers with the first receipt, a message held
 * for capacity is still sent, and the extension is still told how it ended.
 *
 * Every method is synchronous (better-sqlite3).
 *
 * @module services/extensions/agent-send/agent-send-store
 */
import {
  and,
  asc,
  eq,
  extensionAgentChats,
  extensionAgentSends,
  inArray,
  lt,
  type Db,
  type ExtensionAgentSendRow,
  type ExtensionAgentSendStatus,
} from '@dorkos/db';

/** How long a finished message's key keeps answering with its first receipt. */
export const AGENT_SEND_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** The statuses a message can still leave. */
const UNFINISHED: readonly ExtensionAgentSendStatus[] = ['held', 'queued', 'started'];

/** A stored message. */
export type AgentSendRecord = ExtensionAgentSendRow;

/** What may change about a stored message after it is written. */
export type AgentSendPatch = Partial<
  Pick<
    AgentSendRecord,
    'status' | 'receiptStatus' | 'receiptReason' | 'failureReason' | 'sessionId' | 'cwd' | 'content'
  >
>;

/** Reads and writes `extension_agent_sends` and `extension_agent_chats`. */
export class AgentSendStore {
  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   * @param now - Clock, in ms.
   */
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * The message a key already names, while the key still answers: for 24
   * hours after it was sent, and for as long as the message is unfinished.
   *
   * @param extensionId - The extension.
   * @param idempotencyKey - The extension's key.
   */
  findByKey(extensionId: string, idempotencyKey: string): AgentSendRecord | null {
    const row = this.db
      .select()
      .from(extensionAgentSends)
      .where(
        and(
          eq(extensionAgentSends.extensionId, extensionId),
          eq(extensionAgentSends.idempotencyKey, idempotencyKey)
        )
      )
      .get();
    if (!row) return null;
    const expired = Date.parse(row.createdAt) <= this.now() - AGENT_SEND_KEY_TTL_MS;
    return expired && !UNFINISHED.includes(row.status) ? null : row;
  }

  /**
   * One message by id, or null.
   *
   * @param id - The message id.
   */
  get(id: string): AgentSendRecord | null {
    return (
      this.db.select().from(extensionAgentSends).where(eq(extensionAgentSends.id, id)).get() ?? null
    );
  }

  /**
   * Record a message that has just been accepted. A key whose old row has
   * expired is taken over: the old row is deleted first.
   *
   * @param record - The message, without its timestamps.
   */
  insert(record: Omit<AgentSendRecord, 'createdAt' | 'updatedAt'>): AgentSendRecord {
    const at = new Date(this.now()).toISOString();
    const row: AgentSendRecord = { ...record, createdAt: at, updatedAt: at };
    this.db.transaction((tx) => {
      tx.delete(extensionAgentSends)
        .where(
          and(
            eq(extensionAgentSends.extensionId, record.extensionId),
            eq(extensionAgentSends.idempotencyKey, record.idempotencyKey)
          )
        )
        .run();
      tx.insert(extensionAgentSends).values(row).run();
    });
    return row;
  }

  /**
   * Change a stored message.
   *
   * @param id - The message id.
   * @param patch - What changes.
   */
  update(id: string, patch: AgentSendPatch): void {
    this.db
      .update(extensionAgentSends)
      .set({ ...patch, updatedAt: new Date(this.now()).toISOString() })
      .where(eq(extensionAgentSends.id, id))
      .run();
  }

  /**
   * Forget a message entirely: for a send that was refused after its row was
   * written, so the key may be used again.
   *
   * @param id - The message id.
   */
  delete(id: string): void {
    this.db.delete(extensionAgentSends).where(eq(extensionAgentSends.id, id)).run();
  }

  /**
   * Every message in one of the given statuses, oldest first.
   *
   * @param statuses - The statuses to list.
   */
  listByStatus(statuses: readonly ExtensionAgentSendStatus[]): AgentSendRecord[] {
    return this.db
      .select()
      .from(extensionAgentSends)
      .where(inArray(extensionAgentSends.status, [...statuses]))
      .orderBy(asc(extensionAgentSends.createdAt))
      .all();
  }

  /** Delete finished messages sent more than 24 hours ago. */
  prune(): void {
    this.db
      .delete(extensionAgentSends)
      .where(
        and(
          inArray(extensionAgentSends.status, ['done', 'failed']),
          lt(
            extensionAgentSends.createdAt,
            new Date(this.now() - AGENT_SEND_KEY_TTL_MS).toISOString()
          )
        )
      )
      .run();
  }

  /**
   * The chat an extension keeps with an agent, or null when it has none yet.
   *
   * @param extensionId - The extension.
   * @param agentId - The Mesh agent id.
   */
  keptChat(extensionId: string, agentId: string): string | null {
    const row = this.db
      .select({ sessionId: extensionAgentChats.sessionId })
      .from(extensionAgentChats)
      .where(
        and(
          eq(extensionAgentChats.extensionId, extensionId),
          eq(extensionAgentChats.agentId, agentId)
        )
      )
      .get();
    return row?.sessionId ?? null;
  }

  /**
   * The extension that keeps a chat with an agent, or null when no extension
   * keeps it.
   *
   * @param sessionId - The chat's id.
   */
  keptChatOwner(sessionId: string): string | null {
    const row = this.db
      .select({ extensionId: extensionAgentChats.extensionId })
      .from(extensionAgentChats)
      .where(eq(extensionAgentChats.sessionId, sessionId))
      .get();
    return row?.extensionId ?? null;
  }

  /**
   * Remember the chat an extension keeps with an agent, replacing an older one.
   *
   * @param extensionId - The extension.
   * @param agentId - The Mesh agent id.
   * @param sessionId - The chat's canonical id.
   */
  keepChat(extensionId: string, agentId: string, sessionId: string): void {
    const createdAt = new Date(this.now()).toISOString();
    this.db
      .insert(extensionAgentChats)
      .values({ extensionId, agentId, sessionId, createdAt })
      .onConflictDoUpdate({
        target: [extensionAgentChats.extensionId, extensionAgentChats.agentId],
        set: { sessionId, createdAt },
      })
      .run();
  }
}
