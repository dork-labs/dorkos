import type { PoolClient } from 'pg';

/**
 * Lock the channels a newly admitted person joins on arrival: public, unarchived and marked
 * `auto_join`. Call it before any member row lock, as every channel write takes a channel before
 * a member (DOR-2277): taking them the other way round could deadlock with a post or an upload.
 *
 * @returns The channel ids, in id order, for {@link joinAutoJoinChannels}.
 */
export async function lockAutoJoinChannels(
  client: PoolClient,
  communityId: string
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM channels
     WHERE community_id=$1 AND auto_join AND visibility='public' AND NOT archived
     ORDER BY id FOR KEY SHARE`,
    [communityId]
  );
  return result.rows.map((row) => row.id);
}

/** Add a member to each channel {@link lockAutoJoinChannels} returned; a seat already held stays. */
export async function joinAutoJoinChannels(
  client: PoolClient,
  communityId: string,
  memberId: string,
  channelIds: readonly string[]
): Promise<void> {
  if (!channelIds.length) return;
  await client.query(
    `INSERT INTO channel_members(community_id,channel_id,member_id)
     SELECT $1,channel_id,$2 FROM unnest($3::uuid[]) AS channel_id
     ON CONFLICT DO NOTHING`,
    [communityId, memberId, channelIds]
  );
}
