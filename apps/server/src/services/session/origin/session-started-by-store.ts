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
 * A start is announced the moment it is first written ({@link onSessionStartRecorded}),
 * so the work graph can record which chat started which without this domain
 * importing it (ADR 261124-131941).
 *
 * @module services/session/origin/session-started-by-store
 */
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  sessionStartedBy,
  sql,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { logger } from '../../../lib/logger.js';

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
  /**
   * The permission mode a chat's start was granted, or null (an extension's
   * start, or a row from before the level was recorded).
   */
  permissionMode: string | null;
  /** The starting chat's live mode when it started this one, or null. */
  starterPermissionMode: string | null;
  /**
   * Whether the grant was the starter's level exactly, compared by declared
   * level rather than id; null where the levels are.
   */
  permissionSameAsStarter: boolean | null;
  /**
   * Whether a chat's start reports back to the chat that started it (spec
   * `spin-off-chats` §5). True unless `session_start` was told not to.
   */
  reportBack: boolean;
  /**
   * The scheduled thing behind the starting chat when it started this one
   * (`run`, `heartbeat`), or null (DOR-3703, ME). Read by
   * `agent-mode-run-origin.ts`, which takes any other value as a run.
   */
  scheduledOrigin: string | null;
  /**
   * The words a start asked of the new chat, kept until its turn has them,
   * then cleared (spec `turns-survive-restarts` §3.2, DOR-5232): what a
   * restart in between hands over again. Null otherwise.
   */
  prompt: string | null;
  /** The title a start asked for, kept until the chat took it. Null otherwise. */
  title: string | null;
  /** When it was started (ISO 8601). */
  createdAt: string;
}

/** The fields a writer may leave out of a start. */
type DefaultedField =
  | 'carried'
  | 'permissionMode'
  | 'starterPermissionMode'
  | 'permissionSameAsStarter'
  | 'reportBack'
  | 'scheduledOrigin'
  | 'prompt'
  | 'title';

/**
 * A start as a writer hands it in: `carried` defaults to false, the
 * permission levels and the scheduled origin to null, and `reportBack` to true.
 */
export type StartedByInsert = Omit<StartedByRecord, DefaultedField> &
  Partial<Pick<StartedByRecord, DefaultedField>>;

/** Most ids one batched read asks SQLite for at once, well under its variable limit. */
const BATCH = 500;

/** A start as {@link onSessionStartRecorded} hears it: the ids, never the words. */
export interface RecordedStart {
  /** The started chat. */
  sessionId: string;
  /** The chat that started it, or null when no chat did. */
  startedBySessionId: string | null;
  /** A move of a started chat to another account, not a new start. */
  carried: boolean;
}

const startListeners = new Set<(start: RecordedStart) => void>();

/**
 * Hear each start the moment its row is first written, in the same synchronous
 * step. A start already on record (a second insert for the same chat) is not
 * heard again. A listener that throws is logged and never fails the start.
 *
 * @param listener - Called once per new start.
 * @returns A function that stops listening.
 */
export function onSessionStartRecorded(listener: (start: RecordedStart) => void): () => void {
  startListeners.add(listener);
  return () => {
    startListeners.delete(listener);
  };
}

function announceStart(start: RecordedStart): void {
  for (const listener of startListeners) {
    try {
      listener(start);
    } catch (err) {
      logger.warn('[session-started-by] a start listener failed; the start stands', {
        sessionId: start.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

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
   * first starter is the one the chat says. A start that was written is
   * announced to {@link onSessionStartRecorded}'s listeners.
   *
   * @param record - The start; `carried` defaults to false, the levels to null.
   * @returns Whether it was written.
   */
  insert(record: StartedByInsert): boolean {
    const result = this.db.insert(sessionStartedBy).values(record).onConflictDoNothing().run();
    const written = result.changes > 0;
    if (written)
      announceStart({
        sessionId: record.sessionId,
        startedBySessionId: record.startedBySessionId,
        carried: record.carried ?? false,
      });
    return written;
  }

  /**
   * Let a start's words and title go: its run ended (or will never run).
   *
   * @param sessionId - The chat.
   * @param opts.keepTitle - Keep the title: setting it is still under way.
   */
  clearPrompt(sessionId: string, opts: { keepTitle?: boolean } = {}): void {
    this.db
      .update(sessionStartedBy)
      .set(opts.keepTitle ? { prompt: null } : { prompt: null, title: null })
      .where(eq(sessionStartedBy.sessionId, sessionId))
      .run();
  }

  /**
   * The chat took its title: nothing is left to set.
   *
   * @param sessionId - The chat.
   */
  clearTitle(sessionId: string): void {
    this.db
      .update(sessionStartedBy)
      .set({ title: null })
      .where(eq(sessionStartedBy.sessionId, sessionId))
      .run();
  }

  /**
   * The chats an extension's chain started since a moment, carried moves
   * included (a move's successor is still working for the app): what "chats
   * working at once" is counted over, from saved rows.
   *
   * @param originExtensionId - The extension at the root of the chain.
   * @param since - ISO 8601.
   */
  listSince(originExtensionId: string, since: string): string[] {
    return this.db
      .select({ id: sessionStartedBy.sessionId })
      .from(sessionStartedBy)
      .where(
        and(
          eq(sessionStartedBy.originExtensionId, originExtensionId),
          gte(sessionStartedBy.createdAt, since)
        )
      )
      .all()
      .map((row) => row.id);
  }

  /**
   * Every start whose words are still kept: what a boot checks against the
   * runs that name them (a start killed before its run was saved, or before
   * its words were let go).
   */
  withPrompt(): string[] {
    return this.db
      .select({ id: sessionStartedBy.sessionId })
      .from(sessionStartedBy)
      .where(isNotNull(sessionStartedBy.prompt))
      .all()
      .map((row) => row.id);
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
    this.db.transaction((tx) => this.moveWithin(tx, fromId, toId));
  }

  /** Contribute to the caller's actual SQLite transaction; no global store lookup. */
  moveWithin(tx: DbTransaction, fromId: string, toId: string): void {
    if (fromId === toId) return;
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
   * The chat a chat was carried to on another account, when it was (a
   * `carried` start whose starter is this chat), or null.
   *
   * @param sessionId - The chat that was carried away.
   */
  carriedSuccessorOf(sessionId: string): string | null {
    return (
      this.db
        .select({ sessionId: sessionStartedBy.sessionId })
        .from(sessionStartedBy)
        .where(
          and(
            eq(sessionStartedBy.startedBySessionId, sessionId),
            eq(sessionStartedBy.carried, true)
          )
        )
        .orderBy(sessionStartedBy.createdAt)
        .get()?.sessionId ?? null
    );
  }

  /**
   * The chats a chat started (`kind = 'chat'`), oldest first: its spin-offs.
   *
   * @param sessionId - The starting chat.
   */
  childrenOf(sessionId: string): string[] {
    return this.db
      .select({ sessionId: sessionStartedBy.sessionId })
      .from(sessionStartedBy)
      .where(
        and(eq(sessionStartedBy.kind, 'chat'), eq(sessionStartedBy.startedBySessionId, sessionId))
      )
      .orderBy(sessionStartedBy.createdAt)
      .all()
      .map((row) => row.sessionId);
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
