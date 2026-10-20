import type { PoolClient } from 'pg';
import {
  COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS,
  COMMUNITY_MEMBER_DIRECTORY_AGENTS_MAX,
  type CommunityWireAgentAvailability,
  type CommunityWireDirectoryMember,
  type CommunityWireMemberDirectoryPage,
} from '@dorkos/shared/community-wire';
import type { Member } from '../data.js';

interface PersonRow {
  id: string;
  display_name: string;
  handle: string;
  role: Member['role'];
  created_at: Date;
  /** Null unless the person is muted now; an owner never reads as muted. */
  muted_until: Date | null;
}

interface AgentRow {
  id: string;
  display_name: string;
  handle: string;
  owner_member_id: string;
  runs_on: 'computer' | 'agent-computer' | null;
  last_seen_at: Date | null;
  availability: CommunityWireAgentAvailability;
}

/** One page of a space's member directory as read, before it is shown to anyone. */
export interface MemberDirectoryRows {
  people: PersonRow[];
  /** The page's people's active agents; null unless asked for. */
  agents: AgentRow[] | null;
  nextCursor: string | null;
}

/**
 * Read one page of a space's people, oldest id first after `cursor`, and with `withAgents` the
 * active agents those people own (DOR-3005). Every statement names the space, so a page never
 * holds another space's members.
 *
 * @param client - The transaction the caller's role was checked in.
 * @param communityId - The space.
 * @param page - The cursor, page size and whether to read agents.
 */
export async function readMemberDirectory(
  client: PoolClient,
  communityId: string,
  page: { cursor: string | null; limit: number; withAgents: boolean }
): Promise<MemberDirectoryRows> {
  const rows = await client.query<PersonRow>(
    `SELECT id,display_name,handle,role,created_at,
            CASE WHEN muted_until>now() AND role<>'owner' THEN muted_until END AS muted_until
     FROM members
     WHERE community_id=$1 AND kind='person' AND active AND ($2::uuid IS NULL OR id>$2::uuid)
     ORDER BY id LIMIT $3`,
    [communityId, page.cursor, page.limit + 1]
  );
  const people = rows.rows.slice(0, page.limit);
  const agents = page.withAgents
    ? await client.query<AgentRow>(
        // member-kind: agent-owner
        `SELECT a.id,a.display_name,a.handle,a.owner_member_id,a.runs_on,a.last_seen_at,
            CASE WHEN a.last_seen_at IS NULL THEN 'unknown'
              WHEN a.last_seen_at >= now() - make_interval(secs => $3) THEN 'available'
              ELSE 'offline' END AS availability
         FROM agents a
         JOIN members owner ON owner.community_id=a.community_id AND owner.id=a.owner_member_id
         WHERE a.community_id=$1 AND owner.community_id=$1 AND a.active AND owner.active
           AND a.owner_member_id=ANY($2::uuid[])
         ORDER BY a.owner_member_id,a.created_at,a.id
         LIMIT $4`,
        [
          communityId,
          people.map((row) => row.id),
          COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS,
          COMMUNITY_MEMBER_DIRECTORY_AGENTS_MAX,
        ]
      )
    : null;
  return {
    people,
    agents: agents?.rows ?? null,
    nextCursor: rows.rows.length > page.limit ? people.at(-1)!.id : null,
  };
}

/**
 * Show a directory page to one caller. Every member sees names, handles and roles; an owner or
 * admin also sees when each person joined. `showMutes` adds who is muted, and is the route's to
 * decide: an owner or admin in their own browser only. `withAvailability` adds where each agent
 * runs and whether it is there.
 */
export function projectMemberDirectory(
  rows: MemberDirectoryRows,
  view: { moderator: boolean; showMutes: boolean; withAvailability: boolean }
): CommunityWireMemberDirectoryPage {
  return {
    members: rows.people.map((row): CommunityWireDirectoryMember => ({
      memberId: row.id,
      kind: 'human',
      displayName: row.display_name,
      handle: row.handle,
      role: row.role,
      ownerMemberId: null,
      ...(view.moderator ? { joinedAt: row.created_at.toISOString() } : {}),
      ...(view.showMutes ? { mutedUntil: row.muted_until?.toISOString() ?? null } : {}),
    })),
    ...(rows.agents
      ? {
          agents: rows.agents.map((row): CommunityWireDirectoryMember => ({
            memberId: row.id,
            kind: 'agent',
            displayName: row.display_name,
            handle: row.handle,
            role: null,
            ownerMemberId: row.owner_member_id,
            ...(view.withAvailability
              ? {
                  runsOn: row.runs_on,
                  lastSeenAt: row.last_seen_at?.toISOString() ?? null,
                  availability: row.availability,
                }
              : {}),
          })),
        }
      : {}),
    nextCursor: rows.nextCursor,
  };
}
