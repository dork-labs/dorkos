/**
 * How each of a session's usage-limit episodes ended (spec `claude-account-ui`
 * §7.1), kept after the `session_limits` row is gone so the transcript marker
 * can still say what happened.
 *
 * Nothing here decides WHEN to write. {@link SessionLimitStore} owns
 * `session_limits` and calls these inside its own writes, in the same
 * transaction, so the live limit and its history cannot disagree:
 *
 * - a plan that becomes `continued` (a person's pick, flow's
 *   `accounts.markContinued`) records `moved`;
 * - the row's deletion at the session's next `turn_start` records how it
 *   resumed, which is ignored when a `moved` row already holds that episode.
 *
 * One row per (`session_id`, `since`); a second write for an episode is
 * ignored. Every function is synchronous (better-sqlite3).
 *
 * @module services/session/fleet/session-limit-history
 */
import { randomUUID } from 'node:crypto';
import {
  sessionLimitHistory,
  asc,
  desc,
  eq,
  lt,
  type Db,
  type DbTransaction,
  type SessionLimitHistoryRow,
  type SessionLimitRow,
} from '@dorkos/db';
import type { LimitHistoryEntry, LimitResolution } from '@dorkos/shared/account-usage';
import { LimitPlanSchema } from '@dorkos/shared/schemas';

/** A database handle or an open transaction on it. */
type DbOrTx = Db | DbTransaction;

/**
 * What `session_limits.model` holds for a session on its runtime's default
 * model. NULL there means something else: the model was never recorded (a row
 * written before the column existed), which is unknown, never a switch.
 */
export const RUNTIME_DEFAULT_MODEL = '';

/** How many entries the history route serves: the most recent ones. */
export const LIMIT_HISTORY_PAGE = 20;

/** How long a resolved episode is kept before the boot sweep removes it. */
export const LIMIT_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Where a `moved` episode's work went. */
export interface LimitMove {
  /** The session the work carried over to. */
  toSessionId: string;
  /** The account the work carried over to. */
  toAccountId: string;
}

/** What a resumed episode is judged by, besides its own row. */
export interface LimitResumeFacts {
  /** The session's chosen model now, or `null` for the runtime's default. */
  currentModel: string | null;
  /** The moment the session's next turn started. */
  now: Date;
}

/** How a resumed episode ended, and the model switch when that is why. */
export interface ResumedResolution {
  /** One of the three `resumed-*` resolutions. */
  resolution: Exclude<LimitResolution, 'moved'>;
  /** The model before the switch (`resumed-model` only), else `null`. */
  modelFrom: string | null;
  /** The model after the switch (`resumed-model` only), else `null`. */
  modelTo: string | null;
}

/** A stored plan's `resetConfirmedAt`, or `undefined` when it has none or does not parse. */
function resetConfirmedAtOf(planJson: string): string | undefined {
  try {
    const parsed = LimitPlanSchema.safeParse(JSON.parse(planJson));
    if (parsed.success && parsed.data.mode === 'waiting') return parsed.data.resetConfirmedAt;
  } catch {
    // An unreadable plan confirmed nothing.
  }
  return undefined;
}

/**
 * How a limit that was never moved ended, when its row is deleted at the
 * session's next `turn_start`: `resumed-model` when the session's model changed
 * since the limit was hit, else `resumed-reset` when a reading confirmed the
 * reset or its time has passed, else `resumed-early`. A limit whose model was
 * never recorded (`model` NULL) is never read as a switch; a `null` model on
 * either side of a real switch is the runtime's default.
 *
 * @param row - The `session_limits` row being deleted.
 * @param facts - The session's model now, and the clock.
 */
export function resumedResolutionOf(
  row: SessionLimitRow,
  facts: LimitResumeFacts
): ResumedResolution {
  const modelAtLimit = row.model;
  const modelNow = facts.currentModel ?? RUNTIME_DEFAULT_MODEL;
  if (modelAtLimit !== null && modelAtLimit !== modelNow) {
    return {
      resolution: 'resumed-model',
      modelFrom: modelAtLimit === RUNTIME_DEFAULT_MODEL ? null : modelAtLimit,
      modelTo: facts.currentModel,
    };
  }
  const resetPassed = row.resetsAt !== null && facts.now.getTime() >= Date.parse(row.resetsAt);
  if (resetConfirmedAtOf(row.plan) !== undefined || resetPassed) {
    return { resolution: 'resumed-reset', modelFrom: null, modelTo: null };
  }
  return { resolution: 'resumed-early', modelFrom: null, modelTo: null };
}

/**
 * Record how one episode ended. A second write for the same (`session_id`,
 * `since`) is ignored, so the first resolution stands: a `moved` episode stays
 * `moved` when its row is later deleted.
 *
 * @param db - The database or the caller's open transaction.
 * @param row - The episode's `session_limits` row.
 * @param entry - How it ended, when, and on which runtime.
 * @returns Whether a row was written.
 */
export function recordLimitResolution(
  db: DbOrTx,
  row: SessionLimitRow,
  entry: {
    runtime: string;
    resolution: LimitResolution;
    resolvedAt: Date;
    move?: LimitMove;
    modelFrom?: string | null;
    modelTo?: string | null;
  }
): boolean {
  return (
    db
      .insert(sessionLimitHistory)
      .values({
        id: randomUUID(),
        sessionId: row.sessionId,
        since: row.since,
        runtime: entry.runtime,
        accountId: row.accountId,
        window: row.window,
        scope: row.scope,
        resetsAt: row.resetsAt,
        resolution: entry.resolution,
        resolvedAt: entry.resolvedAt.toISOString(),
        toSessionId: entry.move?.toSessionId ?? null,
        toAccountId: entry.move?.toAccountId ?? null,
        modelFrom: entry.modelFrom ?? null,
        modelTo: entry.modelTo ?? null,
      })
      .onConflictDoNothing({ target: [sessionLimitHistory.sessionId, sessionLimitHistory.since] })
      .run().changes > 0
  );
}

function toEntry(row: SessionLimitHistoryRow): LimitHistoryEntry {
  return {
    id: row.id,
    sessionId: row.sessionId,
    since: row.since,
    runtime: row.runtime,
    accountId: row.accountId,
    window: row.window,
    scope: row.scope,
    resetsAt: row.resetsAt,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt,
    toSessionId: row.toSessionId,
    toAccountId: row.toAccountId,
    modelFrom: row.modelFrom,
    modelTo: row.modelTo,
  };
}

/**
 * A session's most recent resolved episodes, at most {@link LIMIT_HISTORY_PAGE},
 * oldest first (the order a transcript reads them in).
 *
 * @param db - The database.
 * @param sessionId - The canonical session id.
 */
export function listLimitHistory(db: DbOrTx, sessionId: string): LimitHistoryEntry[] {
  return db
    .select()
    .from(sessionLimitHistory)
    .where(eq(sessionLimitHistory.sessionId, sessionId))
    .orderBy(desc(sessionLimitHistory.since))
    .limit(LIMIT_HISTORY_PAGE)
    .all()
    .reverse()
    .map(toEntry);
}

/**
 * Move a session's history onto its new id. An episode the new id already
 * holds keeps the row it has; the old id's copy is dropped. Idempotent.
 *
 * @param db - The caller's open transaction.
 * @param fromId - The id the rows are stored under today.
 * @param toId - The id the session is now known by.
 */
export function rekeyLimitHistory(db: DbOrTx, fromId: string, toId: string): void {
  if (fromId === toId) return;
  const rows = db
    .select()
    .from(sessionLimitHistory)
    .where(eq(sessionLimitHistory.sessionId, fromId))
    .orderBy(asc(sessionLimitHistory.since))
    .all();
  if (rows.length === 0) return;
  db.delete(sessionLimitHistory).where(eq(sessionLimitHistory.sessionId, fromId)).run();
  for (const row of rows) {
    db.insert(sessionLimitHistory)
      .values({ ...row, sessionId: toId })
      .onConflictDoNothing({ target: [sessionLimitHistory.sessionId, sessionLimitHistory.since] })
      .run();
  }
}

/**
 * Whether the session has any history row.
 *
 * @param db - The database.
 * @param sessionId - The canonical session id.
 */
export function hasLimitHistory(db: DbOrTx, sessionId: string): boolean {
  return (
    db
      .select({ id: sessionLimitHistory.id })
      .from(sessionLimitHistory)
      .where(eq(sessionLimitHistory.sessionId, sessionId))
      .limit(1)
      .get() !== undefined
  );
}

/**
 * Remove episodes resolved more than {@link LIMIT_HISTORY_RETENTION_MS} ago.
 *
 * @param db - The database.
 * @param now - The clock.
 * @returns How many rows were removed.
 */
export function sweepLimitHistory(db: DbOrTx, now: Date): number {
  const cutoff = new Date(now.getTime() - LIMIT_HISTORY_RETENTION_MS).toISOString();
  return db.delete(sessionLimitHistory).where(lt(sessionLimitHistory.resolvedAt, cutoff)).run()
    .changes;
}
