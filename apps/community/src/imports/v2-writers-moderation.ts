import {
  allRestored,
  insertRows,
  invalid,
  wroteAll,
  type BatchWriter,
} from './v2-write-helpers.js';

// The moderation steps of a version 2 restore, beside `v2-writers.ts`: bans (0033) and reports (0034).

/**
 * Bans keep `origin='imported'`. Each names a member of this export; its confirmed email, when
 * the export has one, is keyed again with this host's secret, so the ban keeps out the same
 * address here. Without one, the exporting host's own key is kept: it matches only if this is
 * that host, with the same auth secret, and is inert anywhere else. No account here is the
 * banned one, so `user_id` stays empty. The adopted owner cannot be banned: an export that says
 * otherwise is refused.
 */
export const writeBans: BatchWriter<'bans'> = async (client, rows, scope) => {
  invalid(rows.some((ban) => ban.member_id === scope.ownerSourceId && ban.lifted_at === null));
  const members = rows.flatMap((ban) =>
    [ban.member_id, ban.actor_member_id].filter((id): id is string => id !== null)
  );
  await allRestored(client, 'members', members.map(scope.derive), scope.communityId);
  wroteAll(
    await insertRows(
      client,
      `INSERT INTO bans(id,community_id,member_id,actor_member_id,email_hash,reason,origin,
         created_at,lifted_at)
       SELECT r.id,$2,r.member_id,r.actor_member_id,r.email_hash,r.reason,'imported',
         r.created_at,r.lifted_at
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,member_id uuid,actor_member_id uuid,
         email_hash text,reason text,created_at timestamptz,lifted_at timestamptz)
       ON CONFLICT DO NOTHING`,
      rows.map((ban) => ({
        id: scope.derive(ban.id),
        member_id: ban.member_id && scope.derive(ban.member_id),
        actor_member_id: ban.actor_member_id && scope.derive(ban.actor_member_id),
        email_hash:
          ban.email && scope.banEmailKey ? scope.banEmailKey(ban.email) : (ban.email_hash ?? null),
        reason: ban.reason,
        created_at: ban.created_at,
        lifted_at: ban.lifted_at,
      })),
      scope.communityId
    ),
    rows.length
  );
};

/**
 * Reports keep `origin='imported'`. Each names a message, and a reporter and a resolver who are
 * members, of this export: a report that names anything else is tampering.
 */
export const writeReports: BatchWriter<'reports'> = async (client, rows, scope) => {
  await allRestored(
    client,
    'entries',
    rows.map((report) => scope.derive(report.entry_id)),
    scope.communityId
  );
  await allRestored(
    client,
    'members',
    rows.flatMap((report) =>
      [report.reporter_member_id, report.resolver_member_id]
        .filter((id): id is string => id !== null)
        .map(scope.derive)
    ),
    scope.communityId
  );
  wroteAll(
    await insertRows(
      client,
      `INSERT INTO reports(id,community_id,entry_id,source,reporter_member_id,check_name,reason,
         note,status,action,resolver_member_id,origin,created_at,resolved_at)
       SELECT r.id,$2,r.entry_id,r.source,r.reporter_member_id,r.check_name,r.reason,r.note,
         r.status,r.action,r.resolver_member_id,'imported',r.created_at,r.resolved_at
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,entry_id uuid,source text,
         reporter_member_id uuid,check_name text,reason text,note text,status text,action text,
         resolver_member_id uuid,created_at timestamptz,resolved_at timestamptz)
       ON CONFLICT DO NOTHING`,
      rows.map((report) => ({
        id: scope.derive(report.id),
        entry_id: scope.derive(report.entry_id),
        source: report.source,
        reporter_member_id: report.reporter_member_id && scope.derive(report.reporter_member_id),
        check_name: report.check_name,
        reason: report.reason,
        note: report.note,
        status: report.status,
        action: report.action,
        resolver_member_id: report.resolver_member_id && scope.derive(report.resolver_member_id),
        created_at: report.created_at,
        resolved_at: report.resolved_at,
      })),
      scope.communityId
    ),
    rows.length
  );
};
