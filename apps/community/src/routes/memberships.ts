import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { CommunityWireMembershipListResponseSchema } from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import { requireSessionUser } from '../data.js';
import { json } from '../http.js';

/** Register the signed-in account's own list of communities it belongs to. */
export function registerMembershipRoutes(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
): void {
  app.get('/memberships', async (c) => {
    const user = await requireSessionUser(c, auth);
    const memberships = await pool.query<{
      community_id: string;
      name: string;
      description: string | null;
      lifecycle:
        'pending_owner' | 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending';
      deletion_notice_at: Date | null;
      short_name: string | null;
      member_id: string;
      display_name: string;
      role: 'owner' | 'admin' | 'member';
    }>(
      `SELECT c.id AS community_id,c.name,c.description,c.lifecycle,
              CASE WHEN c.lifecycle='held' THEN c.deletion_notice_at END AS deletion_notice_at,
              (SELECT n.short_name FROM community_short_names n
                WHERE n.community_id=c.id AND n.state='current') AS short_name,
              m.id AS member_id,m.display_name,m.role
       FROM members m JOIN communities c ON c.id=m.community_id
       WHERE m.user_id=$1 AND m.active
       ORDER BY lower(c.name),c.id`,
      [user.id]
    );
    return json(c, CommunityWireMembershipListResponseSchema, {
      memberships: memberships.rows.map((row) => ({
        communityId: row.community_id,
        name: row.name,
        description: row.description,
        lifecycle: row.lifecycle,
        deletionNoticeAt: row.deletion_notice_at?.toISOString() ?? null,
        shortName: row.short_name,
        memberId: row.member_id,
        displayName: row.display_name,
        role: row.role,
      })),
    });
  });
}
