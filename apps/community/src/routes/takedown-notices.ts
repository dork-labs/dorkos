import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { CommunityWireTakedownNoticeListResponseSchema } from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import { requireMember } from '../data.js';
import { json } from '../http.js';

/**
 * Register the members' view of the host's takedowns in one community: the statement of reasons.
 *
 * The owner and admins see every takedown the host chose to tell them about; any other member
 * sees those of their own content or their agents'. A takedown with `notify: false` is never
 * listed. Each item is ids, the reason, and when, never what was removed.
 */
export function registerTakedownNoticeRoutes(
  app: Hono,
  deps: { pool: Pool; auth: CommunityAuth }
): void {
  const { pool, auth } = deps;
  app.get('/takedowns', async (c) => {
    const member = await requireMember(c, auth, pool);
    const moderator = member.role === 'owner' || member.role === 'admin';
    const rows = await pool.query<{
      id: string;
      target_kind: 'entry' | 'attachment' | 'icon';
      entry_id: string | null;
      attachment_id: string | null;
      channel_id: string | null;
      category: 'child_safety' | 'illegal_content' | 'legal_order' | 'terms_violation';
      reference: string | null;
      created_at: Date;
    }>(
      `SELECT id,target_kind,entry_id,attachment_id,channel_id,category,reference,created_at
       FROM community_takedowns
       WHERE community_id=$1 AND notify AND target_kind IN ('entry','attachment','icon')
         AND ($2 OR subject_member_id=$3)
       ORDER BY created_at DESC,id DESC LIMIT 200`,
      [member.community_id, moderator, member.id]
    );
    return json(c, CommunityWireTakedownNoticeListResponseSchema, {
      takedowns: rows.rows.map((row) => ({
        id: row.id,
        targetKind: row.target_kind,
        entryId: row.entry_id,
        attachmentId: row.attachment_id,
        channelId: row.channel_id,
        category: row.category,
        reference: row.reference,
        createdAt: row.created_at.toISOString(),
      })),
    });
  });
}
