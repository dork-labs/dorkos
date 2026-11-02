import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  CommunityWireMemberReportListResponseSchema,
  CommunityWireMemberReportResolveRequestSchema,
  CommunityWireReportListQuerySchema,
  CommunityWireReportReceiptSchema,
  CommunityWireReportRequestSchema,
  CommunityWireReportResolveResponseSchema,
  type CommunityWireMemberReport,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../../auth.js';
import type { CommunityConfig } from '../../../config.js';
import { requireLiveRole, requireMember, transaction } from '../../../data.js';
import { ApiError, RateLimited, json, readJson } from '../../../http.js';
import { lockOwnMembership } from '../../../moderation/locks.js';
import { muteMember } from '../../../moderation/mutes.js';
import { requirePerson } from '../../../moderation/person.js';
import { banMember, lockCommunityForBan } from './bans.js';
import { OPEN_REPORTS_PER_MEMBER } from './reports.js';

/** How many people one member may flag in an hour. */
export const MEMBER_REPORTS_PER_HOUR = 20;

interface MemberReportRow {
  id: string;
  subject_id: string;
  subject_name: string;
  subject_handle: string | null;
  reason: CommunityWireMemberReport['reason'];
  note: string | null;
  status: CommunityWireMemberReport['status'];
  action: CommunityWireMemberReport['action'];
  reporter_id: string | null;
  reporter_name: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function project(row: MemberReportRow): CommunityWireMemberReport {
  return {
    id: row.id,
    subject: {
      memberId: row.subject_id,
      displayName: row.subject_name,
      handle: row.subject_handle,
    },
    reason: row.reason,
    note: row.note,
    status: row.status,
    action: row.action,
    reporter: row.reporter_id
      ? { memberId: row.reporter_id, displayName: row.reporter_name ?? '' }
      : null,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

/**
 * Register reports of a person (DOR-3624), for what has no one message to point at: a bad name, a
 * profile. Any member reports another person once at a time, and the answer is the same whether
 * or not they had already. Owners and admins read the queue and resolve by muting, banning or
 * dismissing, which closes every open report of that person. Rank rules are the ban's and mute's
 * own.
 *
 * Nobody reads or resolves a report about themselves, whatever their role: it answers as no
 * report at all. An agent never reports or resolves.
 */
export function registerMemberReportRoutes(
  app: Hono,
  { pool, auth, config }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig }
): void {
  app.post('/members/:id/reports', async (c) => {
    // The reporter's browser, or their DorkOS install's grant; never an agent.
    const { member: reporter, recheck } = await requirePerson(c, auth, pool, 'post');
    const subjectId = z.uuid().safeParse(c.req.param('id'));
    if (!subjectId.success) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
    const body = await readJson(c, CommunityWireReportRequestSchema);
    const created = await transaction(pool, async (client) => {
      // The reporter's own row first, so the open-report bound below counts under a lock.
      await lockOwnMembership(client, reporter);
      await requireLiveRole(client, reporter, ['owner', 'admin', 'member']);
      await recheck(client);
      if (subjectId.data === reporter.id)
        throw new ApiError(409, 'STATE_CONFLICT', "You can't report yourself.");
      const subject = await client.query(
        // member-kind: person-write
        `SELECT 1 FROM members WHERE id=$1 AND community_id=$2 AND kind='person' AND active
         FOR SHARE`,
        [subjectId.data, reporter.community_id]
      );
      if (!subject.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
      // One bound across both kinds of report: past it, wait for moderators.
      const open = await client.query<{ count: number }>(
        `SELECT (SELECT count(*) FROM reports
                 WHERE community_id=$1 AND reporter_member_id=$2 AND status='open')
              + (SELECT count(*) FROM member_reports
                 WHERE community_id=$1 AND reporter_member_id=$2 AND status='open') AS count`,
        [reporter.community_id, reporter.id]
      );
      if (Number(open.rows[0].count) >= OPEN_REPORTS_PER_MEMBER)
        throw new RateLimited('You have many reports waiting. Try again later.', 3600);
      // A connection can file these too, so a pace as well as a bound.
      const recent = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM member_reports
         WHERE community_id=$1 AND reporter_member_id=$2 AND created_at>now()-interval '1 hour'`,
        [reporter.community_id, reporter.id]
      );
      if (recent.rows[0].count >= MEMBER_REPORTS_PER_HOUR)
        throw new RateLimited('You have flagged many people this hour. Try again later.', 3600);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO member_reports(community_id,subject_member_id,reporter_member_id,reason,note)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (subject_member_id,reporter_member_id)
           WHERE status='open' AND reporter_member_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [reporter.community_id, subjectId.data, reporter.id, body.reason, body.note ?? null]
      );
      if (!inserted.rows[0]) return false;
      // No actor: an owner's export carries the audit log, and the person a report is about never
      // learns who filed it. `member_reports` itself holds the reporter for the moderators.
      await client.query(
        `INSERT INTO audit_events(community_id,action,subject_id)
         VALUES($1,'member_report.create',$2)`,
        [reporter.community_id, inserted.rows[0].id]
      );
      return true;
    });
    // A second report is a quiet success: the first one already counts.
    return json(c, CommunityWireReportReceiptSchema, { reported: true }, created ? 201 : 200);
  });

  app.get('/member-reports', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const query = CommunityWireReportListQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const open = (query.status ?? 'open') === 'open';
    const reports = await transaction(pool, async (client) => {
      await requireLiveRole(client, actor, ['owner', 'admin'], { allowHeld: true });
      const rows = await client.query<MemberReportRow>(
        // member-kind: named-member
        `SELECT r.id,r.subject_member_id AS subject_id,subject.display_name AS subject_name,
           subject.handle AS subject_handle,r.reason,r.note,r.status,r.action,
           r.reporter_member_id AS reporter_id,reporter.display_name AS reporter_name,
           r.created_at,r.resolved_at
         FROM member_reports r
         JOIN members subject ON subject.id=r.subject_member_id
           AND subject.community_id=r.community_id
         LEFT JOIN members reporter ON reporter.id=r.reporter_member_id
           AND reporter.community_id=r.community_id
         WHERE r.community_id=$1 AND r.subject_member_id<>$2
           AND ${open ? "r.status='open'" : "r.status<>'open'"}
         ORDER BY ${open ? 'r.created_at,r.id' : 'r.resolved_at DESC,r.id DESC'} LIMIT 200`,
        [actor.community_id, actor.id]
      );
      return rows.rows.map(project);
    });
    return json(c, CommunityWireMemberReportListResponseSchema, { reports });
  });

  app.post('/member-reports/:id/resolve', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const reportId = z.uuid().safeParse(c.req.param('id'));
    if (!reportId.success) throw new ApiError(404, 'NOT_FOUND', 'No open report found.');
    const body = await readJson(c, CommunityWireMemberReportResolveRequestSchema);
    const resolved = await transaction(pool, async (client) => {
      // A ban takes the community first, as the ban route does, so it and an admission never
      // interleave.
      if (body.action === 'ban') await lockCommunityForBan(client, actor.community_id);
      const role = await requireLiveRole(client, actor, ['owner', 'admin']);
      const target = await client.query<{ subject_member_id: string }>(
        `SELECT subject_member_id FROM member_reports
         WHERE id=$1 AND community_id=$2 AND status='open'`,
        [reportId.data, actor.community_id]
      );
      const subjectId = target.rows[0]?.subject_member_id;
      if (!subjectId || subjectId === actor.id)
        throw new ApiError(404, 'NOT_FOUND', 'No open report found.');
      // Every open report of the person, in id order, so two moderators queue on the same row.
      await client.query(
        `SELECT 1 FROM member_reports
         WHERE community_id=$1 AND subject_member_id=$2 AND status='open' ORDER BY id FOR UPDATE`,
        [actor.community_id, subjectId]
      );
      const moderator = { id: actor.id, communityId: actor.community_id, role };
      if (body.action === 'mute')
        await muteMember(client, { actor: moderator, targetId: subjectId, minutes: body.minutes });
      else if (body.action === 'ban')
        await banMember(client, {
          actor: moderator,
          targetId: subjectId,
          reason: body.reason,
          authSecret: config.authSecret,
        });
      const dismissed = body.action === 'dismiss';
      const closed = await client.query<{ id: string }>(
        `UPDATE member_reports SET status=$3,action=$4,resolver_member_id=$5,resolved_at=now()
         WHERE community_id=$1 AND subject_member_id=$2 AND status='open' RETURNING id`,
        [
          actor.community_id,
          subjectId,
          dismissed ? 'dismissed' : 'actioned',
          dismissed ? null : body.action,
          actor.id,
        ]
      );
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id,next_state)
         VALUES($1,$2,'member_report.resolve',$3,$4)`,
        [actor.community_id, actor.id, reportId.data, body.action]
      );
      return closed.rowCount ?? 0;
    });
    return json(c, CommunityWireReportResolveResponseSchema, { resolved });
  });
}
