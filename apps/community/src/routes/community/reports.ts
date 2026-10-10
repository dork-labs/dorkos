import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityWireReportListQuerySchema,
  CommunityWireReportListResponseSchema,
  CommunityWireReportReceiptSchema,
  CommunityWireReportRequestSchema,
  CommunityWireReportResolveRequestSchema,
  CommunityWireReportResolveResponseSchema,
  type CommunityWireReport,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { requireLiveRole, requireMember, transaction, type Member } from '../../data.js';
import { ApiError, RateLimited, json, readJson } from '../../http.js';
import { removalAuthority, removeEntry } from '../../content-removal.js';
import { lockOwnMembership } from '../../moderation/locks.js';
import { muteMember } from '../../moderation/mutes.js';
import { banMember, lockCommunityForBan } from './bans.js';

/** How many of one member's reports may wait in the queue at once. */
export const OPEN_REPORTS_PER_MEMBER = 50;

/** The longest excerpt of a reported message the queue shows. */
const EXCERPT_LENGTH = 280;

interface ReportRow {
  id: string;
  entry_id: string;
  channel_id: string;
  source: 'member' | 'check';
  check_name: string | null;
  reason: CommunityWireReport['reason'];
  note: string | null;
  status: CommunityWireReport['status'];
  action: CommunityWireReport['action'];
  reporter_id: string | null;
  reporter_name: string | null;
  author_id: string;
  author_name: string;
  author_kind: 'human' | 'agent';
  text: string;
  readable: boolean;
  created_at: Date;
  resolved_at: Date | null;
}

/**
 * Every report a moderator may see, with its message's author and an excerpt. `$1` is the
 * community, `$2` the reading moderator (whose channel seats decide what they may read).
 */
const REPORT_SELECT = `SELECT r.id,r.entry_id,e.channel_id,r.source,r.check_name,r.reason,r.note,
    r.status,r.action,r.reporter_member_id AS reporter_id,reporter.display_name AS reporter_name,
    COALESCE(e.author_member_id,e.author_agent_id) AS author_id,e.author_display_name AS author_name,
    CASE WHEN e.author_agent_id IS NULL THEN 'human' ELSE 'agent' END AS author_kind,e.text,
    (ch.visibility='public' OR EXISTS(
      SELECT 1 FROM channel_members cm WHERE cm.channel_id=ch.id AND cm.member_id=$2)) AS readable,
    r.created_at,r.resolved_at
  FROM reports r
  JOIN entries e ON e.id=r.entry_id AND e.community_id=r.community_id
  JOIN channels ch ON ch.id=e.channel_id AND ch.community_id=e.community_id
  LEFT JOIN members reporter ON reporter.id=r.reporter_member_id
    AND reporter.community_id=r.community_id`;

function project(row: ReportRow): CommunityWireReport {
  return {
    id: row.id,
    entryId: row.entry_id,
    channelId: row.channel_id,
    source: row.source,
    checkName: row.check_name,
    reason: row.reason,
    // The note often quotes the message, so it is hidden with it.
    note: row.readable ? row.note : null,
    status: row.status,
    action: row.action,
    reporter: row.reporter_id
      ? { memberId: row.reporter_id, displayName: row.reporter_name ?? '' }
      : null,
    author: { memberId: row.author_id, displayName: row.author_name, kind: row.author_kind },
    // A report never opens a private channel to a moderator outside it.
    excerpt: row.readable ? row.text.slice(0, EXCERPT_LENGTH) : null,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

/** The reported message's author, as the human its moderation acts on. */
interface ReportedAuthor {
  entry_id: string;
  author_member_id: string | null;
  author_agent_id: string | null;
  human_id: string;
  human_role: Member['role'];
  human_active: boolean;
}

async function lockReport(
  client: PoolClient,
  reportId: string,
  communityId: string
): Promise<ReportedAuthor> {
  // Every open report of the message, in id order, before any one of them: two moderators
  // resolving two reports of one message then queue on the same first row instead of each
  // holding one and waiting on the other's.
  const target = await client.query<{ entry_id: string }>(
    'SELECT entry_id FROM reports WHERE id=$1 AND community_id=$2',
    [reportId, communityId]
  );
  if (target.rows[0])
    await client.query(
      `SELECT 1 FROM reports WHERE community_id=$1 AND entry_id=$2 AND status='open'
       ORDER BY id FOR UPDATE`,
      [communityId, target.rows[0].entry_id]
    );
  const result = await client.query<ReportedAuthor>(
    `SELECT r.entry_id,e.author_member_id,e.author_agent_id,
       COALESCE(e.author_member_id,a.owner_member_id) AS human_id,m.role AS human_role,
       m.active AS human_active
     FROM reports r
     JOIN entries e ON e.id=r.entry_id AND e.community_id=r.community_id
     LEFT JOIN agents a ON a.id=e.author_agent_id
     JOIN members m ON m.id=COALESCE(e.author_member_id,a.owner_member_id)
     WHERE r.id=$1 AND r.community_id=$2 AND r.status='open'`,
    [reportId, communityId]
  );
  if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'No open report found.');
  return result.rows[0];
}

/**
 * Register reports: any member reports a message they can read, once; owners and admins read
 * the queue and resolve a report by removing the message, muting or banning its author (an
 * agent's owner), or dismissing it. Resolving closes every open report of the same message,
 * from members and from checks alike, and every step is audited.
 */
export function registerReportRoutes(
  app: Hono,
  { pool, auth, config }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig }
): void {
  app.post('/entries/:id/reports', async (c) => {
    const reporter = await requireMember(c, auth, pool);
    const entryId = z.uuid().safeParse(c.req.param('id'));
    if (!entryId.success) throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
    const body = await readJson(c, CommunityWireReportRequestSchema);
    const created = await transaction(pool, async (client) => {
      // The reporter's own row first, so the open-report bound below counts under a lock.
      await lockOwnMembership(client, reporter);
      await requireLiveRole(client, reporter, ['owner', 'admin', 'member']);
      const entry = await client.query<{ removed: boolean; own: boolean; readable: boolean }>(
        `SELECT (e.removed_at IS NOT NULL OR e.erased_at IS NOT NULL) AS removed,
           (e.author_member_id=$3 OR a.owner_member_id=$3) AS own,
           (ch.visibility='public' OR EXISTS(SELECT 1 FROM channel_members cm
             WHERE cm.channel_id=ch.id AND cm.member_id=$3)) AS readable
         FROM entries e JOIN channels ch ON ch.id=e.channel_id
         LEFT JOIN agents a ON a.id=e.author_agent_id
         WHERE e.id=$1 AND e.community_id=$2
         FOR SHARE OF e`,
        [entryId.data, reporter.community_id, reporter.id]
      );
      const found = entry.rows[0];
      // A message in a channel the reporter cannot read is the same as no message at all.
      if (!found?.readable) throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
      if (found.removed)
        throw new ApiError(409, 'STATE_CONFLICT', 'This message was already removed.');
      if (found.own)
        throw new ApiError(409, 'STATE_CONFLICT', "You can't report your own message.");
      // A bound on what one person can pile into the queue: past it, wait for moderators.
      const open = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reports
         WHERE community_id=$1 AND reporter_member_id=$2 AND status='open'`,
        [reporter.community_id, reporter.id]
      );
      if (open.rows[0].count >= OPEN_REPORTS_PER_MEMBER)
        throw new RateLimited('You have many reports waiting. Try again later.', 3600);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reports(community_id,entry_id,source,reporter_member_id,reason,note)
         VALUES($1,$2,'member',$3,$4,$5)
         ON CONFLICT (entry_id,reporter_member_id)
           WHERE source='member' AND reporter_member_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [reporter.community_id, entryId.data, reporter.id, body.reason, body.note ?? null]
      );
      if (!inserted.rows[0]) return false;
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id)
         VALUES($1,$2,'report.create',$3)`,
        [reporter.community_id, reporter.id, inserted.rows[0].id]
      );
      return true;
    });
    // A second report of the same message is a quiet success: the first one already counts.
    return json(c, CommunityWireReportReceiptSchema, { reported: true }, created ? 201 : 200);
  });

  app.get('/reports', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const query = CommunityWireReportListQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const open = (query.status ?? 'open') === 'open';
    const rows = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin'], { allowHeld: true });
      return client.query<ReportRow>(
        `${REPORT_SELECT} WHERE r.community_id=$1 AND ${open ? "r.status='open'" : "r.status<>'open'"}
         ORDER BY ${open ? 'r.created_at,r.id' : 'r.resolved_at DESC,r.id DESC'} LIMIT 200`,
        [actor.community_id, actor.id]
      );
    });
    return json(c, CommunityWireReportListResponseSchema, { reports: rows.rows.map(project) });
  });

  app.post('/reports/:id/resolve', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const reportId = z.uuid().safeParse(c.req.param('id'));
    if (!reportId.success) throw new ApiError(404, 'NOT_FOUND', 'No open report found.');
    const body = await readJson(c, CommunityWireReportResolveRequestSchema);
    const resolved = await transaction(pool, async (client) => {
      // A ban takes the community first, as the ban route does, so it and an admission never
      // interleave. Every other action takes it only to share, as a direct removal does: holding
      // it for update while a removal waits on a channel a post holds would deadlock with it.
      if (body.action === 'ban') await lockCommunityForBan(client, actor.community_id);
      const role = await requireLiveRole(client, actor, ['owner', 'admin']);
      const reported = await lockReport(client, reportId.data, actor.community_id);
      const moderator = { id: actor.id, communityId: actor.community_id, role };
      if (body.action === 'remove') {
        // The same rank rule as removing a message directly.
        const removedBy = removalAuthority(
          { kind: 'human', id: actor.id, role },
          {
            agentId: reported.author_agent_id,
            humanId: reported.human_id,
            humanRole: reported.human_role,
            humanActive: reported.human_active,
          }
        );
        // A moderator's own message reported to them is theirs to delete.
        if (!removedBy) throw new ApiError(403, 'FORBIDDEN', "You can't remove this message.");
        const removed = await removeEntry(client, {
          communityId: actor.community_id,
          entryId: reported.entry_id,
          removedBy,
        });
        if (removed.changed)
          await client.query(
            `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,changed_fields)
             VALUES($1,$2,$3,$4,ARRAY['text','mentions','attachments'])`,
            [
              actor.community_id,
              actor.id,
              removedBy === 'author' ? 'entry.delete' : 'entry.remove',
              reported.entry_id,
            ]
          );
      } else if (body.action === 'mute') {
        await muteMember(client, {
          actor: moderator,
          targetId: reported.human_id,
          minutes: body.minutes,
        });
      } else if (body.action === 'ban') {
        await banMember(client, {
          actor: moderator,
          targetId: reported.human_id,
          reason: body.reason,
          authSecret: config.authSecret,
        });
      }
      const dismissed = body.action === 'dismiss';
      const closed = await client.query<{ id: string }>(
        `UPDATE reports SET status=$3,action=$4,resolver_member_id=$5,resolved_at=now()
         WHERE community_id=$1 AND entry_id=$2 AND status='open' RETURNING id`,
        [
          actor.community_id,
          reported.entry_id,
          dismissed ? 'dismissed' : 'actioned',
          dismissed ? null : body.action,
          actor.id,
        ]
      );
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,next_state)
         VALUES($1,$2,'report.resolve',$3,$4)`,
        [actor.community_id, actor.id, reportId.data, body.action]
      );
      return closed.rowCount ?? 0;
    });
    return json(c, CommunityWireReportResolveResponseSchema, { resolved });
  });
}
