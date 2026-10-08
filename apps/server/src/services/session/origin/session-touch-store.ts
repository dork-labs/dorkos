/**
 * When you last touched each chat, kept in `session_touches` (spec
 * `your-activity-first` D1).
 *
 * Two writers, both in `routes/session-touch-handler.ts` and both behind
 * `isPersonAtTheApp`: `POST /:id/opened` when the chat page shows a chat, and
 * `POST /:id/messages` once a message you wrote is accepted. Nothing an agent,
 * a room, a task or a binding does reaches either, so a row here is a person's
 * act whatever started the chat. One reader: the "touched by you" overlay,
 * which turns a row into `Session.lastTouchedByYouAt` and gives a room-, task-
 * or agent-born chat back the message time you earned in it.
 *
 * Synchronous (better-sqlite3), like {@link SessionStartedByStore}: the overlays
 * that read it are synchronous.
 *
 * Rows are never deleted. There is no route that deletes a chat, and the one
 * "chat is gone" signal (`onSessionRemoved`) also fires when a watcher blinks,
 * so deleting on it could quietly stop a live chat being yours. A row for a
 * chat that really is gone is three short columns no list will ever match.
 *
 * @module services/session/origin/session-touch-store
 */
import { eq, inArray, sessionTouches, sql, type Db } from '@dorkos/db';

/** What the store knows about one chat; either time may be missing. */
export interface SessionTouch {
  /** When you last opened it on the chat page (ISO 8601), or null. */
  openedAt: string | null;
  /** When you last wrote in it from the app (ISO 8601), or null. */
  wroteAt: string | null;
}

/** Most ids one batched read asks SQLite for at once, well under its variable limit. */
const BATCH = 500;

/**
 * The later of two ISO times, by instant rather than by string, so a time
 * written with an offset still compares correctly against one written in UTC.
 * A missing or unreadable side loses.
 *
 * @param a - One time, or null.
 * @param b - The other, or null.
 */
export function laterIso(
  a: string | null | undefined,
  b: string | null | undefined
): string | null {
  const at = a ? Date.parse(a) : Number.NaN;
  const bt = b ? Date.parse(b) : Number.NaN;
  if (Number.isNaN(at)) return Number.isNaN(bt) ? null : (b ?? null);
  if (Number.isNaN(bt)) return a ?? null;
  return bt > at ? b! : a!;
}

/** Reads and writes `session_touches`. */
export class SessionTouchStore {
  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   */
  constructor(private readonly db: Db) {}

  /**
   * Record that you opened a chat. An earlier time never replaces a later
   * one, so a slow request arriving after a newer one cannot move it back.
   * The SQL `max` compares text, which orders correctly only because every
   * writer passes `Date.prototype.toISOString()` (fixed width, UTC).
   *
   * @param sessionId - The chat's canonical id.
   * @param at - When (ISO 8601).
   */
  recordOpened(sessionId: string, at: string): void {
    this.db
      .insert(sessionTouches)
      .values({ sessionId, openedAt: at })
      .onConflictDoUpdate({
        target: sessionTouches.sessionId,
        set: { openedAt: sql`max(coalesce(${sessionTouches.openedAt}, ''), excluded.opened_at)` },
      })
      .run();
  }

  /**
   * Record that you wrote in a chat. Writing means you had it open, so it
   * moves the open time too; neither time ever moves backwards.
   *
   * @param sessionId - The chat's canonical id.
   * @param at - When (ISO 8601).
   */
  recordWrote(sessionId: string, at: string): void {
    this.db
      .insert(sessionTouches)
      .values({ sessionId, openedAt: at, wroteAt: at })
      .onConflictDoUpdate({
        target: sessionTouches.sessionId,
        set: {
          openedAt: sql`max(coalesce(${sessionTouches.openedAt}, ''), excluded.opened_at)`,
          wroteAt: sql`max(coalesce(${sessionTouches.wroteAt}, ''), excluded.wrote_at)`,
        },
      })
      .run();
  }

  /**
   * The touches of these chats, by id; chats you never touched are absent.
   *
   * @param sessionIds - The chats.
   */
  resolve(sessionIds: readonly string[]): Map<string, SessionTouch> {
    const found = new Map<string, SessionTouch>();
    const unique = [...new Set(sessionIds)];
    for (let i = 0; i < unique.length; i += BATCH) {
      const rows = this.db
        .select()
        .from(sessionTouches)
        .where(inArray(sessionTouches.sessionId, unique.slice(i, i + BATCH)))
        .all();
      for (const row of rows) {
        found.set(row.sessionId, { openedAt: row.openedAt, wroteAt: row.wroteAt });
      }
    }
    return found;
  }

  /**
   * Move a chat's touches to the id the runtime settled on. When the
   * canonical id already has a row, the later of each time is kept.
   *
   * @param fromId - The id the chat was known by.
   * @param toId - Its canonical id.
   */
  move(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db.transaction((tx) => {
      const source = tx
        .select()
        .from(sessionTouches)
        .where(eq(sessionTouches.sessionId, fromId))
        .get();
      if (!source) return;
      const target = tx
        .select()
        .from(sessionTouches)
        .where(eq(sessionTouches.sessionId, toId))
        .get();
      const merged = {
        openedAt: laterIso(source.openedAt, target?.openedAt),
        wroteAt: laterIso(source.wroteAt, target?.wroteAt),
      };
      tx.delete(sessionTouches).where(eq(sessionTouches.sessionId, fromId)).run();
      tx.insert(sessionTouches)
        .values({ sessionId: toId, ...merged })
        .onConflictDoUpdate({ target: sessionTouches.sessionId, set: merged })
        .run();
    });
  }
}

let current: SessionTouchStore | undefined;

/**
 * Wire the store at boot (or clear it in a test).
 *
 * @param store - The store, or undefined.
 */
export function setSessionTouchStore(store: SessionTouchStore | undefined): void {
  current = store;
}

/** The wired store, or undefined before boot. */
export function getSessionTouchStore(): SessionTouchStore | undefined {
  return current;
}
