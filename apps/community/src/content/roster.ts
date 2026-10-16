import type { Pool, PoolClient } from 'pg';
import {
  COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS,
  type CommunityWireAgentAvailability,
} from '@dorkos/shared/community-wire';
import type { Member } from '../data.js';

/**
 * An agent's availability from its last report, read on the database clock, the clock that
 * dated the report: `communityAgentAvailability` in the shared wire, in SQL.
 */
const AGENT_AVAILABILITY_SQL = `CASE WHEN a.last_seen_at IS NULL THEN 'unknown'
      WHEN a.last_seen_at >= now() - make_interval(secs => ${COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS})
        THEN 'available' ELSE 'offline' END`;

/**
 * Everyone who can be addressed in one channel: its active joined members, then its active
 * joined agents whose owners are active, oldest join first, each agent with its last
 * availability report. `$1` is the channel, `$2` its community.
 *
 * Every join names the community, so each table is read through its `(community_id, …)` index.
 * Joined only on `id`, the planner hashed every membership on the host, all 46,200 at the
 * measured scale, to answer for a channel of 1,000, once per post and once per roster view
 * (DOR-2572).
 */
export const CHANNEL_ROSTER_SQL =
  // member-kind: agent-owner
  `SELECT m.id,m.display_name,m.handle,m.role,NULL::uuid AS owner_member_id,
    NULL::text AS owner_display_name,'human'::text AS kind,cm.joined_at,
    NULL::text AS runs_on,NULL::timestamptz AS last_seen_at,NULL::text AS availability
  FROM channel_members cm
  JOIN members m ON m.community_id=cm.community_id AND m.id=cm.member_id
  WHERE cm.channel_id=$1 AND cm.community_id=$2 AND m.community_id=$2 AND m.active
    AND m.kind='person'
  UNION ALL
  SELECT a.id,a.display_name,a.handle,NULL::text AS role,a.owner_member_id,
    owner.display_name AS owner_display_name,'agent'::text AS kind,acm.joined_at,
    a.runs_on,a.last_seen_at,${AGENT_AVAILABILITY_SQL} AS availability
  FROM agent_channel_members acm
  JOIN agents a ON a.community_id=acm.community_id AND a.id=acm.agent_id
  JOIN members owner ON owner.community_id=a.community_id AND owner.id=a.owner_member_id
  WHERE acm.channel_id=$1 AND acm.community_id=$2 AND a.community_id=$2
    AND owner.community_id=$2 AND a.active AND owner.active
  ORDER BY joined_at,id`;

/**
 * The part of a channel's roster one post can address: whoever has one of `$3`'s lowercased
 * handles, or one of `$4`'s ids. A post reads this rather than the whole roster, which in a
 * channel of 20,000 is 20,000 rows read while the channel is locked, once per post.
 */
const ADDRESSED_ROSTER_SQL = `SELECT * FROM (${CHANNEL_ROSTER_SQL}) roster
  WHERE lower(roster.handle)=ANY($3::text[]) OR roster.id=ANY($4::uuid[])
  ORDER BY roster.joined_at,roster.id`;

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
  /** An agent's last availability report (0039); always NULL for a person. */
  runs_on: 'computer' | 'agent-computer' | null;
  last_seen_at: Date | null;
  /** Derived from `last_seen_at` on the database clock; always NULL for a person. */
  availability: CommunityWireAgentAvailability | null;
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

/**
 * Read the members and agents of a channel's roster that `handles` or `ids` name, in roster
 * order. Nothing named reads nothing, with no query.
 *
 * @param db - The pool, or the client of the transaction the roster must be read in.
 * @param channelId - The channel.
 * @param communityId - The channel's community; a channel of another community reads as empty.
 * @param handles - Lowercased handles, as `mentionCandidates` gives them.
 * @param ids - Member and agent ids.
 */
export async function addressedRoster(
  db: Pick<Pool | PoolClient, 'query'>,
  channelId: string,
  communityId: string,
  handles: readonly string[],
  ids: readonly string[]
): Promise<ChannelRosterRow[]> {
  if (!handles.length && !ids.length) return [];
  return (
    await db.query<ChannelRosterRow>(ADDRESSED_ROSTER_SQL, [channelId, communityId, handles, ids])
  ).rows;
}
