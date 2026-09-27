/**
 * The durable half of a session's usage limit (spec `claude-account-fleet` D4).
 *
 * A projector holds `status.limit` like `lastError`, but Claude Code's projector
 * records only a few event types and never hydrates status, so a limit held in
 * memory alone was gone after a restart or an idle eviction. This keeps one
 * `session_limits` row per limited session: written when the runtime reports a
 * limit, read by a projector created for that session, deleted at the
 * session's next `turn_start`, and moved when the session is rekeyed.
 *
 * Every method is synchronous (better-sqlite3), and every caller on a turn's
 * path goes through {@link getSessionLimitStore}, which is `undefined` until
 * boot wires a store, so a unit test without a database simply keeps nothing.
 *
 * @module services/session/fleet/session-limit-store
 */
import { sessionLimits, and, eq, inArray, type Db, type SessionLimitRow } from '@dorkos/db';
import {
  LimitPlanSchema,
  LimitStateSchema,
  type LimitPlan,
  type LimitState,
  type SessionLimit,
} from '@dorkos/shared/schemas';

import { logger } from '../../../lib/logger.js';

/** Whether a limit stopped the whole account or one model's window. */
export type SessionLimitScope = 'account' | 'model';

/** One session's stored limit, in the shape the rest of the server reads. */
export interface StoredSessionLimit {
  /** The canonical session id. */
  sessionId: string;
  /** The limit as the session status carries it. */
  limit: SessionLimit;
  /** Whether the account or one model's window ran out. */
  scope: SessionLimitScope;
  /** The Claude config folder the session ran in, or `null` when unknown. */
  accountPath: string | null;
  /** Where the limit stands; the same value as `limit.state`. */
  state: LimitState;
  /** The session's working directory when the limit was hit, or `null` when unknown. */
  cwd: string | null;
  /** The extension id of the advisor that claimed the session, or `null` when none did. */
  claimedBy: string | null;
  /**
   * The plan exactly as stored, the version a conditional write compares
   * against ({@link SessionLimitStore.update} `expectPlanJson`).
   */
  planJson: string;
  /** The row's last write, ISO 8601. */
  updatedAt: string;
}

/** What {@link SessionLimitStore.update} may change on a stored limit. */
export interface SessionLimitPatch {
  /** The new plan. */
  plan?: LimitPlan;
  /** The new state. */
  state?: LimitState;
  /** The model offered in place of the one that ran out; `null` clears it. */
  modelFallback?: string | null;
  /** The earliest reset when every account is out; `null` clears it. */
  allOut?: { accountId: string; resetsAt: string | null } | null;
  /** The advisor that claimed the session. */
  claimedBy?: string | null;
}

/** What {@link SessionLimitStore.upsert} writes. */
export interface SessionLimitWrite {
  /** The canonical session id. */
  sessionId: string;
  /** The limit as the session status carries it. */
  limit: SessionLimit;
  /** Whether the account or one model's window ran out. */
  scope: SessionLimitScope;
  /** The Claude config folder the session ran in, or `null` when unknown. */
  accountPath: string | null;
  /** Where the limit stands; `limited` when omitted. */
  state?: LimitState;
  /** The session's working directory, when the runtime knew it. */
  cwd?: string | null;
}

/** SQLite binds at most 999 variables in older builds; stay well under. */
const ID_CHUNK_SIZE = 500;

/**
 * The scope a window key implies: a per-model window (`seven_day_opus`,
 * `seven_day_sonnet`, or a `model:*` bucket) stops one model, anything else
 * the whole account.
 *
 * @param window - The ledger window key.
 */
export function limitScopeOf(window: string): SessionLimitScope {
  return window === 'seven_day_opus' || window === 'seven_day_sonnet' || window.startsWith('model:')
    ? 'model'
    : 'account';
}

/** A stored plan, or `ask` when the JSON no longer parses (never throws on a read). */
function parsePlan(json: string): LimitPlan {
  try {
    const parsed = LimitPlanSchema.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch {
    // Fall through to the default below.
  }
  return { mode: 'ask' };
}

/** A stored state, or `limited` for a value this build does not know. */
function parseState(value: string): LimitState {
  const parsed = LimitStateSchema.safeParse(value);
  return parsed.success ? parsed.data : 'limited';
}

/** A stored `all_out`, or `undefined` when absent or unreadable. */
function parseAllOut(json: string | null): SessionLimit['allOut'] {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as { accountId?: unknown; resetsAt?: unknown };
    if (typeof value.accountId !== 'string') return undefined;
    return {
      accountId: value.accountId,
      resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : null,
    };
  } catch {
    return undefined;
  }
}

function toStored(row: SessionLimitRow): StoredSessionLimit {
  const state = parseState(row.state);
  const allOut = parseAllOut(row.allOut);
  return {
    sessionId: row.sessionId,
    limit: {
      accountId: row.accountId,
      window: row.window,
      resetsAt: row.resetsAt,
      since: row.since,
      plan: parsePlan(row.plan),
      scope: row.scope,
      state,
      ...(row.modelFallback ? { modelFallback: row.modelFallback } : {}),
      ...(allOut ? { allOut } : {}),
    },
    scope: row.scope,
    accountPath: row.accountPath,
    state,
    cwd: row.cwd,
    claimedBy: row.claimedBy,
    planJson: row.plan,
    updatedAt: row.updatedAt,
  };
}

/** Reads and writes the `session_limits` table. */
export class SessionLimitStore {
  /**
   * Build a store over the shared database.
   *
   * @param db - The shared DorkOS database.
   * @param now - The clock, for `updated_at` (tests pin it).
   */
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Write a session's limit, replacing any row it already had.
   *
   * @param write - The session, its limit and the facts beside it.
   */
  upsert(write: SessionLimitWrite): void {
    const values = {
      sessionId: write.sessionId,
      since: write.limit.since,
      window: write.limit.window,
      scope: write.scope,
      resetsAt: write.limit.resetsAt,
      accountId: write.limit.accountId,
      accountPath: write.accountPath,
      plan: JSON.stringify(write.limit.plan ?? { mode: 'ask' }),
      state: write.state ?? 'limited',
      cwd: write.cwd ?? null,
      // A new episode starts unplanned: the fallback, the earliest reset and
      // the claim are the out-of-usage flow's to work out again (D9).
      modelFallback: null,
      allOut: null,
      claimedBy: null,
      updatedAt: this.now().toISOString(),
    };
    const { sessionId: _key, ...update } = values;
    this.db
      .insert(sessionLimits)
      .values(values)
      .onConflictDoUpdate({ target: sessionLimits.sessionId, set: update })
      .run();
  }

  /**
   * Change a stored limit, but only while it is still the episode the caller
   * read: a row whose `since` moved on (a newer limit) or that is gone (the
   * session's next turn started) is left alone.
   *
   * With `opts.expectPlanJson`, also only while the plan is still the one the
   * caller read (compare-and-set), so a decision made on a stale read never
   * overwrites a newer one.
   *
   * @param sessionId - The canonical session id.
   * @param since - The episode the caller planned for (`limit.since`).
   * @param patch - What to change.
   * @param opts.expectPlanJson - The plan as read ({@link StoredSessionLimit.planJson}).
   * @returns Whether a row was changed.
   */
  update(
    sessionId: string,
    since: string,
    patch: SessionLimitPatch,
    opts: { expectPlanJson?: string } = {}
  ): boolean {
    const set: Partial<typeof sessionLimits.$inferInsert> = {
      updatedAt: this.now().toISOString(),
    };
    if (patch.plan !== undefined) set.plan = JSON.stringify(patch.plan);
    if (patch.state !== undefined) set.state = patch.state;
    if (patch.modelFallback !== undefined) set.modelFallback = patch.modelFallback;
    if (patch.allOut !== undefined) {
      set.allOut = patch.allOut === null ? null : JSON.stringify(patch.allOut);
    }
    if (patch.claimedBy !== undefined) set.claimedBy = patch.claimedBy;
    return (
      this.db
        .update(sessionLimits)
        .set(set)
        .where(
          and(
            eq(sessionLimits.sessionId, sessionId),
            eq(sessionLimits.since, since),
            ...(opts.expectPlanJson !== undefined
              ? [eq(sessionLimits.plan, opts.expectPlanJson)]
              : [])
          )
        )
        .run().changes > 0
    );
  }

  /** Every stored limit, for a sweep over all limited sessions. */
  list(): StoredSessionLimit[] {
    return this.db.select().from(sessionLimits).all().map(toStored);
  }

  /**
   * One session's stored limit, or `undefined` when it has none.
   *
   * @param sessionId - The canonical session id.
   */
  get(sessionId: string): StoredSessionLimit | undefined {
    const row = this.db
      .select()
      .from(sessionLimits)
      .where(eq(sessionLimits.sessionId, sessionId))
      .get();
    return row ? toStored(row) : undefined;
  }

  /**
   * The stored limits of the named sessions, keyed by session id; sessions
   * with none are absent. One query per 500 ids, for a whole list page.
   *
   * @param sessionIds - The sessions to look up.
   */
  getMany(sessionIds: readonly string[]): Map<string, StoredSessionLimit> {
    const out = new Map<string, StoredSessionLimit>();
    for (let i = 0; i < sessionIds.length; i += ID_CHUNK_SIZE) {
      const chunk = sessionIds.slice(i, i + ID_CHUNK_SIZE);
      const rows = this.db
        .select()
        .from(sessionLimits)
        .where(inArray(sessionLimits.sessionId, chunk))
        .all();
      for (const row of rows) out.set(row.sessionId, toStored(row));
    }
    return out;
  }

  /**
   * Every limited session whose plan still has something to wait for: a
   * person chose to wait for the reset (`waiting`), or the work is scheduled to
   * carry over (`auto`). What a resume service scans at boot.
   */
  listWaiting(): StoredSessionLimit[] {
    return this.db
      .select()
      .from(sessionLimits)
      .all()
      .map(toStored)
      .filter(
        (stored) => stored.limit.plan.mode === 'waiting' || stored.limit.plan.mode === 'auto'
      );
  }

  /**
   * Forget a session's limit. Its next turn has started, so it no longer
   * stands. Deleting a session with no row does nothing.
   *
   * @param sessionId - The canonical session id.
   * @returns Whether a row was deleted.
   */
  delete(sessionId: string): boolean {
    return (
      this.db.delete(sessionLimits).where(eq(sessionLimits.sessionId, sessionId)).run().changes > 0
    );
  }

  /**
   * Carry a session's limit onto its new id. When both ids hold a row, the
   * newer limit (by `since`) is kept, since that is the one the session's last
   * turn reported. Idempotent.
   *
   * @param fromId - The id the row is stored under today.
   * @param toId - The id the session is now known by.
   */
  rekeySession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db.transaction((tx) => {
      const source = tx
        .select()
        .from(sessionLimits)
        .where(eq(sessionLimits.sessionId, fromId))
        .get();
      if (!source) return;
      const destination = tx
        .select()
        .from(sessionLimits)
        .where(eq(sessionLimits.sessionId, toId))
        .get();
      tx.delete(sessionLimits).where(eq(sessionLimits.sessionId, fromId)).run();
      if (destination && destination.since >= source.since) return;
      if (destination) tx.delete(sessionLimits).where(eq(sessionLimits.sessionId, toId)).run();
      tx.insert(sessionLimits)
        .values({ ...source, sessionId: toId })
        .run();
    });
  }
}

let sharedStore: SessionLimitStore | undefined;

/**
 * Install the process-wide store, once at boot after `createDb()`. Passing
 * `undefined` clears it (test isolation).
 *
 * @param store - The store, or `undefined`.
 */
export function setSessionLimitStore(store: SessionLimitStore | undefined): void {
  sharedStore = store;
}

/** The process-wide store, or `undefined` when none is wired. */
export function getSessionLimitStore(): SessionLimitStore | undefined {
  return sharedStore;
}

/**
 * Run a store call from a turn's path: never throws (a failed write costs the
 * limit's survival across a restart, never the turn), and does nothing without
 * a store.
 *
 * @param what - A short name for the call, for the log line.
 * @param fn - The call.
 */
export function withSessionLimitStore<T>(
  what: string,
  fn: (store: SessionLimitStore) => T
): T | undefined {
  const store = sharedStore;
  if (!store) return undefined;
  try {
    return fn(store);
  } catch (err) {
    logger.warn('[session-limits] could not reach the session limit table', {
      what,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
