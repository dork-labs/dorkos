import type { PoolClient } from 'pg';

/**
 * Take the caller's own member row for update, after the community row's share that every
 * write takes first. A person's own changes (accepting the rules, renaming, reporting) then
 * queue behind each other: two at once from two tabs would otherwise each hold a share of the
 * row the other's update waits on, which is a deadlock. Call it before `requireLiveRole`.
 */
export async function lockOwnMembership(
  client: PoolClient,
  member: { id: string; community_id: string }
): Promise<void> {
  await client.query('SELECT 1 FROM communities WHERE id=$1 FOR SHARE', [member.community_id]);
  await client.query('SELECT 1 FROM members WHERE id=$1 AND community_id=$2 FOR UPDATE', [
    member.id,
    member.community_id,
  ]);
}
