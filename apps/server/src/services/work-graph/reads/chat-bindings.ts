/**
 * The work graph's one reader of chat bindings (`session_metadata`): which
 * chats this DorkOS bound, to which agent folder and runtime, and when. The
 * lineage query (W3) and the read tools (W4) read bindings here and nowhere
 * else, so when the work graph moves to the space store (DOR-5139) this module
 * is what changes, and nothing that calls it.
 *
 * A binding lives on the computer that runs the chat, so this lists only the
 * chats THIS DorkOS knows. A chat on another computer comes with the space's
 * own record (W8), not here.
 *
 * @module services/work-graph/reads/chat-bindings
 */
import { and, desc, eq, inArray, isNotNull, lt, or, sessionMetadata, type Db } from '@dorkos/db';

/** Most ids one batched read asks SQLite for at once, well under its variable limit. */
const BATCH = 500;

/** One chat bound to an agent's folder. */
export interface ChatBinding {
  /** The chat's id. */
  chatId: string;
  /** When this DorkOS first bound it (ISO 8601). */
  createdAt: string;
  /** The runtime it runs on, or null before its first turn claimed one. */
  runtime: string | null;
}

/** Where a page of bindings starts: after this one, in newest-first order. */
export interface BindingCursor {
  /** The last listed binding's `createdAt`. */
  createdAt: string;
  /** The last listed binding's chat id. */
  chatId: string;
}

/**
 * The ids among these that are bound to a runtime.
 *
 * @param db - The DorkOS database.
 * @param ids - Chat ids.
 */
export function boundChatIds(db: Db, ids: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += BATCH) {
    const rows = db
      .select({ sessionId: sessionMetadata.sessionId })
      .from(sessionMetadata)
      .where(
        and(
          inArray(sessionMetadata.sessionId, ids.slice(i, i + BATCH)),
          isNotNull(sessionMetadata.runtime)
        )
      )
      .all();
    for (const row of rows) found.add(row.sessionId);
  }
  return found;
}

/**
 * Up to `limit` chats bound to one agent folder, newest first (ties by id,
 * highest first), after `after`. Ended chats are listed too: a binding stays
 * for the chat's life.
 *
 * @param db - The DorkOS database.
 * @param agentPath - The agent's folder, exactly as it was bound.
 * @param after - Where the page starts, or null for the first page.
 * @param limit - How many at most.
 */
export function agentBindingsPage(
  db: Db,
  agentPath: string,
  after: BindingCursor | null,
  limit: number
): ChatBinding[] {
  const ofAgent = eq(sessionMetadata.agentPath, agentPath);
  const where = after
    ? and(
        ofAgent,
        or(
          lt(sessionMetadata.createdAt, after.createdAt),
          and(
            eq(sessionMetadata.createdAt, after.createdAt),
            lt(sessionMetadata.sessionId, after.chatId)
          )
        )
      )
    : ofAgent;
  return db
    .select({
      chatId: sessionMetadata.sessionId,
      createdAt: sessionMetadata.createdAt,
      runtime: sessionMetadata.runtime,
    })
    .from(sessionMetadata)
    .where(where)
    .orderBy(desc(sessionMetadata.createdAt), desc(sessionMetadata.sessionId))
    .limit(limit)
    .all();
}

/**
 * Every chat id bound to one agent folder, in no particular order.
 *
 * @param db - The DorkOS database.
 * @param agentPath - The agent's folder, exactly as it was bound.
 */
export function agentChatIds(db: Db, agentPath: string): string[] {
  return db
    .select({ sessionId: sessionMetadata.sessionId })
    .from(sessionMetadata)
    .where(eq(sessionMetadata.agentPath, agentPath))
    .all()
    .map((row) => row.sessionId);
}
