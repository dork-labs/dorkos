import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Whether this member has asked to leave for good: an open erasure of this membership, or of
 * the whole account behind it. Ownership must not move to someone who is being erased.
 */
export async function memberIsLeaving(
  client: Queryable,
  member: { id: string; community_id: string; user_id: string | null }
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM erasure_requests
     WHERE state IN ('scheduled','running') AND (
       (kind='membership' AND community_id=$1 AND member_id=$2)
       OR (kind='account' AND user_id=$3)
     ) LIMIT 1`,
    [member.community_id, member.id, member.user_id]
  );
  return Boolean(result.rowCount);
}

/** Whether an account erasure is waiting or running for this account. */
export async function accountErasureOpen(client: Queryable, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM erasure_requests
     WHERE kind='account' AND user_id=$1 AND state IN ('scheduled','running') LIMIT 1`,
    [userId]
  );
  return Boolean(result.rowCount);
}

/**
 * Why this account may not sign in, or null when it may: its erasure is running, or the host
 * closed it and the closure has not been cancelled.
 */
export async function signInRefusal(client: Queryable, userId: string): Promise<string | null> {
  const result = await client.query<{ running: boolean; closed: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM erasure_requests
         WHERE kind='account' AND user_id=$1 AND state='running') AS running,
       EXISTS (SELECT 1 FROM account_closures WHERE user_id=$1 AND state='closed') AS closed`,
    [userId]
  );
  const { running, closed } = result.rows[0];
  if (running) return 'This account is being deleted.';
  if (closed) return 'This account has been closed.';
  return null;
}

/**
 * Whether redeeming an invitation would bring this account back into a community while it is
 * being erased: its account erasure is running anywhere, or its membership erasure is running
 * in this community.
 */
export async function readmissionBlocked(
  client: Queryable,
  communityId: string,
  userId: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM erasure_requests r
     WHERE r.state='running' AND (
       (r.kind='account' AND r.user_id=$2)
       OR (r.kind='membership' AND r.community_id=$1 AND EXISTS (
         SELECT 1 FROM members m
         WHERE m.id=r.member_id AND m.community_id=r.community_id AND m.user_id=$2
       ))
     ) LIMIT 1`,
    [communityId, userId]
  );
  return Boolean(result.rowCount);
}

/**
 * SQL, for an erasure request aliased `r`: true while a whole-community takedown's evidence has
 * not settled in a community it touches (its own, for a membership erasure; any the account
 * belongs to, for an account erasure). Such an erasure waits, so the copy for the authorities is
 * what was there at the takedown.
 */
export const ERASURE_WAITS_ON_TAKEDOWN_SQL = `EXISTS (
  SELECT 1 FROM community_takedowns t
  WHERE t.target_kind='community'
    AND t.evidence_state IN ('pending','retrying','failed','held_on_primary')
    AND (
      (r.kind='membership' AND t.community_id=r.community_id)
      OR (r.kind='account' AND EXISTS (
        SELECT 1 FROM members m WHERE m.community_id=t.community_id AND m.user_id=r.user_id))
    )
)`;

/**
 * SQL, for an erasure request aliased `r`: true while it belongs to an open host closure the
 * person did not ask for themselves (the account request, or a membership request the account
 * erasure made under it) and a community it touches is under a legal hold. Such an erasure
 * waits until the hold is released. A person's own request is not held: a legal hold does not
 * stop anyone erasing themselves (OPERATIONS.md, "Legal holds").
 */
export const ERASURE_WAITS_ON_LEGAL_HOLD_SQL = `(EXISTS (
  SELECT 1 FROM account_closures ac
  WHERE ac.erasure_request_id=COALESCE(r.parent_request_id,r.id)
    AND ac.state='closed' AND NOT ac.person_requested
) AND EXISTS (
  SELECT 1 FROM communities c
  WHERE c.legal_hold_at IS NOT NULL AND (
    (r.kind='membership' AND c.id=r.community_id)
    OR (r.kind='account' AND EXISTS (
      SELECT 1 FROM members m WHERE m.community_id=c.id AND m.user_id=r.user_id))
  )
))`;

/** Whether this running account erasure must stop and wait for a legal hold to be released. */
export async function erasureHeldByLegalHold(
  client: Queryable,
  requestId: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM erasure_requests r WHERE r.id=$1 AND ${ERASURE_WAITS_ON_LEGAL_HOLD_SQL}`,
    [requestId]
  );
  return Boolean(result.rowCount);
}
