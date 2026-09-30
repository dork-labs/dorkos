import type { Pool, PoolClient } from 'pg';
import type { Member } from '../data.js';

/**
 * Everyone who can be addressed in one channel: its active joined members, then its active
 * joined agents whose owners are active, oldest join first. `$1` is the channel, `$2` its
 * community.
 *
 * Every join names the community, so each table is read through its `(community_id, …)` index.
 * Joined only on `id`, the planner hashed every membership on the host, all 46,200 at the
 * measured scale, to answer for a channel of 1,000, once per post and once per roster view
 * (DOR-2572).
 */
export const CHANNEL_ROSTER_SQL = `SELECT m.id,m.display_name,m.handle,m.role,NULL::uuid AS owner_member_id,
    NULL::text AS owner_display_name,'human'::text AS kind,cm.joined_at
  FROM channel_members cm
  JOIN members m ON m.community_id=cm.community_id AND m.id=cm.member_id
  WHERE cm.channel_id=$1 AND cm.community_id=$2 AND m.community_id=$2 AND m.active
  UNION ALL
  SELECT a.id,a.display_name,a.handle,NULL::text AS role,a.owner_member_id,
    owner.display_name AS owner_display_name,'agent'::text AS kind,acm.joined_at
  FROM agent_channel_members acm
  JOIN agents a ON a.community_id=acm.community_id AND a.id=acm.agent_id
  JOIN members owner ON owner.community_id=a.community_id AND owner.id=a.owner_member_id
  WHERE acm.channel_id=$1 AND acm.community_id=$2 AND a.community_id=$2
    AND owner.community_id=$2 AND a.active AND owner.active
  ORDER BY joined_at,id`;

/** One row of {@link CHANNEL_ROSTER_SQL}. */
export interface ChannelRosterRow {
  id: string;
  display_name: string;
  handle: string;
  role: Member['role'] | null;
  owner_member_id: string | null;
  owner_display_name: string | null;
  kind: 'human' | 'agent';
  joined_at: Date;
}

/**
 * Read {@link CHANNEL_ROSTER_SQL}: the channel's addressable members and agents.
 *
 * @param db - The pool, or the client of the transaction the roster must be read in.
 * @param channelId - The channel.
 * @param communityId - The channel's community; a channel of another community reads as empty.
 */
export async function channelRoster(
  db: Pick<Pool | PoolClient, 'query'>,
  channelId: string,
  communityId: string
): Promise<ChannelRosterRow[]> {
  return (await db.query<ChannelRosterRow>(CHANNEL_ROSTER_SQL, [channelId, communityId])).rows;
}
