import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

/**
 * What one request knew when it began: the database snapshot taken before it read any password,
 * provider link, session or account. A clean-out (`clearAccountAccess`) this snapshot cannot see
 * had not committed yet, so anything the request read may predate it.
 */
interface RequestStart {
  /** `pg_current_snapshot()` as text, taken on the database's clock, never the app's. */
  snapshot: string;
  /**
   * The account this very request cleared, whose new session and link are the point of it, and
   * the clearing transaction's id. The request stays exempt only while that clean-out is still
   * the account's latest.
   */
  cleared: { userId: string; xid: string } | null;
}

const storage = new AsyncLocalStorage<RequestStart>();

/**
 * Run one request with its start recorded. Every mutating `/api/*` request and every Better Auth
 * request but `GET /get-session` runs inside this (`app.ts`, `auth.ts`). A request already
 * inside one keeps its first, earlier start.
 */
export async function withRequestStart<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  if (storage.getStore()) return work();
  const taken = await pool.query<{ snapshot: string }>(
    'SELECT pg_current_snapshot()::text AS snapshot'
  );
  return storage.run({ snapshot: taken.rows[0].snapshot, cleared: null }, work);
}

/** Whether the current request has a recorded start: every mutating `/api/*` request does. */
export function hasRequestStart(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Note that the current request cleared this account, in the transaction `xid` (as returned by
 * `clearAccountAccess`), so its own session and link are new. The exemption is bound to that
 * transaction, not to the account: should another clean-out commit after it (a second reset, a
 * recovery, a trusted takeover), this request's later writes are judged like anyone's.
 */
export function markAccessCleared(userId: string, xid: string): void {
  const start = storage.getStore();
  if (start) start.cleared = { userId, xid };
}

/**
 * Whether a session or `account` row for this account, written by the current request, must not
 * stand: the account was cleared (`"user".access_cleared_xid`) by a transaction the request's
 * start snapshot cannot see, so whatever the request authenticated with, or checked before
 * writing, may be something the clean-out removed. The request that did the clean-out is exempt
 * while the account's stamp is still its own clean-out's (`markAccessCleared`).
 *
 * `lock` takes the row `FOR SHARE`, which waits for a clean-out still holding it `FOR UPDATE`
 * and then reads the committed stamp, so the answer is never "not yet cleared" for a clean-out
 * about to commit.
 *
 * A request with no recorded start is refused: it means a session- or account-writing path was
 * added without the wrapper, and judging it from "now" would let exactly this race through.
 *
 * @throws {Error} When the current request has no recorded start.
 */
export async function writtenBeforeClearing(
  client: Pick<Pool | PoolClient, 'query'>,
  userId: string,
  { lock }: { lock: boolean }
): Promise<boolean> {
  const start = storage.getStore();
  if (!start)
    throw new Error(
      'No request start recorded for a sign-in write; wrap the route in withRequestStart.'
    );
  const ownXid = start.cleared?.userId === userId ? start.cleared.xid : null;
  const stale = await client.query<{ stale: boolean }>(
    `SELECT access_cleared_xid IS NOT NULL
       AND NOT pg_visible_in_snapshot(access_cleared_xid, $2::pg_snapshot)
       AND access_cleared_xid::text IS DISTINCT FROM $3::text AS stale
     FROM "user" WHERE id=$1 ${lock ? 'FOR SHARE' : ''}`,
    [userId, start.snapshot, ownXid]
  );
  return stale.rows[0]?.stale === true;
}
