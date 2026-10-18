/**
 * What an import checks of a direct message (DOR-2955): the shape the database already holds it
 * to, plus the references it cannot. A direct message holds one person and one agent of this
 * export; a membership row naming anyone else in it, or a direct message naming someone who is
 * not a person or not an agent of this export, is tampering, and fails the import.
 *
 * @module imports/v2-direct-messages
 */
import type { PoolClient } from 'pg';
import { invalid } from './v2-write-helpers.js';

/**
 * Refuse a batch of membership rows unless each one in a direct message names that direct
 * message's own person (`seat` `member`) or agent (`seat` `agent`). Ids are already derived.
 *
 * @param client - The restore's transaction.
 * @param seat - Which of the two the rows seat.
 * @param rows - Each row's channel and the member or agent it seats.
 * @param communityId - The importing community.
 */
export async function onlyItsOwnMembers(
  client: PoolClient,
  seat: 'member' | 'agent',
  rows: readonly { channelId: string; id: string }[],
  communityId: string
): Promise<void> {
  if (!rows.length) return;
  const strangers = await client.query(
    `SELECT 1 FROM unnest($2::uuid[],$3::uuid[]) AS r(channel_id,id)
     JOIN channels c ON c.community_id=$1 AND c.id=r.channel_id AND c.kind='dm'
     WHERE r.id <> ${seat === 'member' ? 'c.dm_member_id' : 'c.dm_agent_id'} LIMIT 1`,
    [communityId, rows.map((row) => row.channelId), rows.map((row) => row.id)]
  );
  invalid((strangers.rowCount ?? 0) > 0);
}

/**
 * Refuse a restore whose direct messages name anyone but a person and an agent it restored.
 * Run once every channel, member and agent is written.
 *
 * @param client - The restore's transaction.
 * @param communityId - The importing community.
 */
export async function directMessagesResolve(
  client: PoolClient,
  communityId: string
): Promise<void> {
  const broken = await client.query(
    // member-kind: import-check
    `SELECT 1 FROM channels c WHERE c.community_id=$1 AND c.kind='dm' AND (
       NOT EXISTS (SELECT 1 FROM members m
         WHERE m.community_id=$1 AND m.id=c.dm_member_id AND m.kind='person')
       OR NOT EXISTS (SELECT 1 FROM agents a WHERE a.community_id=$1 AND a.id=c.dm_agent_id))
     LIMIT 1`,
    [communityId]
  );
  invalid((broken.rowCount ?? 0) > 0);
}
