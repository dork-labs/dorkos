/**
 * Who started a chat that no person typed into, kept in `session_started_by`
 * (spec `flow-multiproject` §7.7, D13).
 *
 * Two writers: the start-work seam (`api.startWork`, `ctx.sessions.start`),
 * which records `kind = 'extension'`, and the `session_start` tool, which
 * records `kind = 'chat'` and inherits the calling chat's origin extension.
 * Two readers: the session-origin overlays, which turn a row into
 * `Session.startedBy`, and the start limits, which count rows by origin
 * extension. The count is read here rather than kept in memory so a restart
 * cannot reset it.
 *
 * Every method is synchronous (better-sqlite3), which is what lets the limit
 * check and the insert that claims a slot run with no await between them.
 *
 * @module services/session/origin/session-started-by-store
 */
import { and, eq, gte, inArray, sessionStartedBy, sql, type Db } from '@dorkos/db';

/** One stored start. */
export interface StartedByRecord {
  /** The started chat. */
  sessionId: string;
  /** An extension started it, or another chat did. */
  kind: 'extension' | 'chat';
  /** The extension that started it, for `kind = 'extension'`. */
  extensionId: string | null;
  /** The chat that started it, for `kind = 'chat'`. */
  startedBySessionId: string | null;
  /** The extension at the root of the chain, or null when none. */
  originExtensionId: string | null;
  /** Why it was started, or null. */
  reason: string | null;
  /** A move of a started chat to another account: outside the hourly count. */
  carried: boolean;
  /** When it was started (ISO 8601). */
  createdAt: string;
}

/** Most ids one batched read asks SQLite for at once, well under its variable limit. */
const BATCH = 500;

/** Reads and writes `session_started_by`. */
export class SessionStartedByStore {
  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   */
  constructor(private readonly db: Db) {}

  /**
   * Record a start. A second record for the same chat replaces nothing: the
   * first starter is the one the chat says.
   *
   * @param record - The start; `carried` defaults to false.
   * @returns Whether it was written.
   */
  insert(record: Omit<StartedByRecord, 'carried'> & { carried?: boolean }): boolean {
    const result = this.db.insert(sessionStartedBy).values(record).onConflictDoNothing().run();
    return result.changes > 0;
  }

  /**
   * Forget a start that never launched, so it neither shows nor counts.
   *
   * @param sessionId - The chat.
   */
  remove(sessionId: string): void {
    this.db.delete(sessionStartedBy).where(eq(sessionStartedBy.sessionId, sessionId)).run();
  }

  /**
   * Move a chat's row, and every row that names it as the starter, to the id
   * the runtime settled on. Nothing happens when nothing is stored under
   * `fromId`.
   *
   * @param fromId - The id the chat was known by.
   * @param toId - Its canonical id.
   */
  move(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db.transaction((tx) => {
      const taken = tx
        .select({ id: sessionStartedBy.sessionId })
        .from(sessionStartedBy)
        .where(eq(sessionStartedBy.sessionId, toId))
        .get();
      if (!taken) {
        tx.update(sessionStartedBy)
          .set({ sessionId: toId })
          .where(eq(sessionStartedBy.sessionId, fromId))
          .run();
      }
      tx.update(sessionStartedBy)
        .set({ startedBySessionId: toId })
        .where(eq(sessionStartedBy.startedBySessionId, fromId))
        .run();
    });
  }

  /**
   * The stored start of one chat, or null.
   *
   * @param sessionId - The chat.
   */
  get(sessionId: string): StartedByRecord | null {
    return (
      this.db
        .select()
        .from(sessionStartedBy)
        .where(eq(sessionStartedBy.sessionId, sessionId))
        .get() ?? null
    );
  }

  /**
   * The stored starts of these chats, by id; chats nobody started are absent.
   *
   * @param sessionIds - The chats.
   */
  getMany(sessionIds: readonly string[]): Map<string, StartedByRecord> {
    const found = new Map<string, StartedByRecord>();
    const unique = [...new Set(sessionIds)];
    for (let i = 0; i < unique.length; i += BATCH) {
      const rows = this.db
        .select()
        .from(sessionStartedBy)
        .where(inArray(sessionStartedBy.sessionId, unique.slice(i, i + BATCH)))
        .all();
      for (const row of rows) found.set(row.sessionId, row);
    }
    return found;
  }

  /**
   * How many chats an extension's chain started since `since`. A move to
   * another account is not a start and is left out.
   *
   * @param originExtensionId - The extension at the root of the chain.
   * @param since - ISO 8601; rows at or after it count.
   */
  countSince(originExtensionId: string, since: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(sessionStartedBy)
      .where(
        and(
          eq(sessionStartedBy.originExtensionId, originExtensionId),
          gte(sessionStartedBy.createdAt, since),
          eq(sessionStartedBy.carried, false)
        )
      )
      .get();
    return row?.n ?? 0;
  }
}

let current: SessionStartedByStore | undefined;

/**
 * Wire the store at boot (or clear it in a test).
 *
 * @param store - The store, or undefined.
 */
export function setSessionStartedByStore(store: SessionStartedByStore | undefined): void {
  current = store;
}

/** The wired store, or undefined before boot. */
export function getSessionStartedByStore(): SessionStartedByStore | undefined {
  return current;
}
