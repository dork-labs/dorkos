import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

/**
 * What one sign-in request knew when it began: the database snapshot taken before it read any
 * password, provider link or account. A clean-out (`clearAccountAccess`) that this snapshot
 * cannot see had not committed yet, so anything the request read may predate it.
 */
interface RequestStart {
  /** `pg_current_snapshot()` as text, taken on the database's clock, never the app's. */
  snapshot: string;
  /** The account this very request cleared, whose new session is the point of the clean-out. */
  clearedUserId: string | null;
}

const storage = new AsyncLocalStorage<RequestStart>();

/**
 * Run one request that may make a session with its start recorded. Every Better Auth request
 * that can sign someone in, and the password link route, runs inside this.
 */
export async function withRequestStart<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  const taken = await pool.query<{ snapshot: string }>(
    'SELECT pg_current_snapshot()::text AS snapshot'
  );
  return storage.run({ snapshot: taken.rows[0].snapshot, clearedUserId: null }, work);
}

/** Note that the current request cleared this account, so its own session is the new one. */
export function markAccessCleared(userId: string): void {
  const start = storage.getStore();
  if (start) start.clearedUserId = userId;
}

/**
 * Whether a session for this account, made by the current request, must not stand: the account
 * was cleared (`"user".access_cleared_xid`) by a transaction the request's start snapshot cannot
 * see, so the password or link the request authenticated with may be one the clean-out removed.
 * The request that did the clean-out is exempt.
 *
 * `lock` takes the row `FOR SHARE`, which waits for a clean-out still holding it `FOR UPDATE`
 * and then reads the committed stamp, so the answer is never "not yet cleared" for a clean-out
 * about to commit.
 *
 * A request with no recorded start (a session made outside every path `withRequestStart`
 * wraps) is judged from now: later than its real start, so it catches only clean-outs that had
 * committed by now. Every session-making route in this server is wrapped; this is the fallback.
 */
export async function sessionPredatesClearing(
  client: Pick<Pool | PoolClient, 'query'>,
  userId: string,
  { lock }: { lock: boolean }
): Promise<boolean> {
  const start = storage.getStore();
  if (start?.clearedUserId === userId) return false;
  const stale = await client.query<{ stale: boolean }>(
    `SELECT access_cleared_xid IS NOT NULL
       AND NOT pg_visible_in_snapshot(access_cleared_xid, COALESCE($2::pg_snapshot, pg_current_snapshot()))
       AS stale
     FROM "user" WHERE id=$1 ${lock ? 'FOR SHARE' : ''}`,
    [userId, start?.snapshot ?? null]
  );
  return stale.rows[0]?.stale === true;
}
