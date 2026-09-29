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

/** Whether an account erasure is running for this account, so it may not sign in. */
export async function accountErasureRunning(client: Queryable, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM erasure_requests WHERE kind='account' AND user_id=$1 AND state='running' LIMIT 1`,
    [userId]
  );
  return Boolean(result.rowCount);
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
