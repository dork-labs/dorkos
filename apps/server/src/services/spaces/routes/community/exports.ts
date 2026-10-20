import type { Context, Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireExportListSchema,
  CommunityWireExportResponseSchema,
  CommunityWireOwnerExportRequestSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { lockActiveCommunity, requireMember, transaction, type Member } from '../../data.js';
import type { ConfirmPassword } from '../../password-confirmation.js';
import { ApiError, json, readJson } from '../../http.js';
import type { BlobStore } from '../../storage/index.js';
import { OWNER_EXPORT_LIFECYCLES, type ExportScope } from '../../exports/authority.js';
import { endExportJob, EXPORT_COLUMNS, toWireExport, type ExportRow } from '../../exports/store.js';
import { signLinkForSession } from '../../user-content/access.js';
import { UserContentLinkResponseSchema } from '../../user-content/links.js';
import { streamExportArchive } from './downloads/export-download.js';

/** Exports still open, or ended within the last week, are listed. */
const LISTED = `(state IN ('queued','building')
  OR (state='ready' AND COALESCE(deleted_at,expires_at)>now()-interval '7 days')
  OR (state IN ('failed','cancelled') AND ended_at>now()-interval '7 days'))`;

// Lock lifecycle before membership, matching administration mutations. Archived authority is
// specific to owner exports; ordinary mutations remain active-only.
async function lockExportAuthority(
  client: PoolClient,
  member: Member,
  scope: ExportScope
): Promise<void> {
  if (scope === 'personal') await lockActiveCommunity(client, member.community_id);
  const community = await client.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
    [member.community_id]
  );
  const lifecycle = community.rows[0]?.lifecycle ?? '';
  if (!(OWNER_EXPORT_LIFECYCLES as readonly string[]).includes(lifecycle))
    throw new ApiError(409, 'COMMUNITY_UNAVAILABLE', 'This space cannot be exported now.');
  const live = await client.query<{ role: Member['role'] }>(
    // member-kind: by-grant
    'SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
    [member.id, member.community_id]
  );
  if (!live.rows[0] || (scope === 'owner' && live.rows[0].role !== 'owner'))
    throw new ApiError(403, 'FORBIDDEN', 'Export access has ended.');
}

/** Register export jobs, their status and cancellation, and the resumable archive download. */
export function registerExportRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    blobStore,
    confirmPassword,
  }: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    blobStore: BlobStore;
    confirmPassword: ConfirmPassword;
  }
) {
  /**
   * Queue an export, or return the one already open: a queued or building job, or a ready
   * archive that has not expired, for the same requester and scope.
   */
  const create = async (member: Member, scope: ExportScope) => {
    const current = await pool.query<Member>(
      // member-kind: by-grant
      'SELECT id,user_id,display_name,role,community_id FROM members WHERE id=$1 AND community_id=$2 AND active',
      [member.id, member.community_id]
    );
    if (!current.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
    if (scope === 'owner' && current.rows[0].role !== 'owner')
      throw new ApiError(403, 'FORBIDDEN', 'Only the owner can export the space.');
    return transaction(pool, async (client) => {
      await lockExportAuthority(client, member, scope);
      // One creator at a time per community (owner) or member (personal).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `community-export:${member.community_id}:${scope}:${scope === 'owner' ? '' : member.id}`,
      ]);
      const open = await client.query<ExportRow>(
        `SELECT ${EXPORT_COLUMNS} FROM export_archives
         WHERE community_id=$1 AND requester_member_id=$2 AND scope=$3
           AND (state IN ('queued','building')
             OR (state='ready' AND deleted_at IS NULL AND expires_at>now()))
         ORDER BY created_at DESC LIMIT 1`,
        [member.community_id, member.id, scope]
      );
      if (open.rows[0]) return { row: open.rows[0], created: false };
      if (scope === 'owner') {
        // A job a former owner left in progress would fail at its next segment anyway.
        const stale = await client.query<{ id: string }>(
          `SELECT id FROM export_archives
           WHERE community_id=$1 AND scope='owner' AND state IN ('queued','building')
             AND requester_member_id<>$2 FOR UPDATE`,
          [member.community_id, member.id]
        );
        for (const job of stale.rows)
          await endExportJob(
            client,
            job.id,
            { state: 'failed', code: 'EXPORT_ACCESS_ENDED' },
            new Date()
          );
      }
      const inserted = await client.query<ExportRow>(
        `INSERT INTO export_archives(community_id,requester_member_id,scope,format_version,state)
         VALUES($1,$2,$3,3,'queued') RETURNING ${EXPORT_COLUMNS}`,
        [member.community_id, member.id, scope]
      );
      return { row: inserted.rows[0], created: true };
    });
  };

  const answer = (c: Context, row: ExportRow, status = 200) =>
    json(c, CommunityWireExportResponseSchema, { export: toWireExport(row, new Date()) }, status);

  app.post('/me/export', async (c) => {
    const member = await requireMember(c, auth, pool);
    const { row, created } = await create(member, 'personal');
    return answer(c, row, created ? 202 : 200);
  });

  app.post('/owner/export', async (c) => {
    const member = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireOwnerExportRequestSchema);
    await confirmPassword(c, member.user_id, body.password);
    const { row, created } = await create(member, 'owner');
    return answer(c, row, created ? 202 : 200);
  });

  app.get('/exports', async (c) => {
    const member = await requireMember(c, auth, pool);
    const result = await pool.query<ExportRow>(
      `SELECT ${EXPORT_COLUMNS} FROM export_archives
       WHERE community_id=$1 AND requester_member_id=$2 AND ${LISTED}
       ORDER BY created_at DESC,id LIMIT 50`,
      [member.community_id, member.id]
    );
    const now = new Date();
    return json(c, CommunityWireExportListSchema, {
      exports: result.rows.map((row) => toWireExport(row, now)),
    });
  });

  const own = async (member: Member, id: string, lock?: PoolClient): Promise<ExportRow> => {
    const result = await (lock ?? pool).query<ExportRow>(
      `SELECT ${EXPORT_COLUMNS} FROM export_archives
       WHERE id=$1 AND requester_member_id=$2 AND community_id=$3${lock ? ' FOR UPDATE' : ''}`,
      [id, member.id, member.community_id]
    );
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Export not found.');
    return result.rows[0];
  };

  app.get('/exports/:id', async (c) => {
    const member = await requireMember(c, auth, pool);
    return answer(c, await own(member, c.req.param('id')));
  });

  app.post('/exports/:id/cancel', async (c) => {
    const member = await requireMember(c, auth, pool);
    const row = await transaction(pool, async (client) => {
      const current = await own(member, c.req.param('id'), client);
      if (current.state === 'ready')
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'This export is ready and can no longer be cancelled.'
        );
      if (current.state === 'queued' || current.state === 'building')
        await endExportJob(client, current.id, { state: 'cancelled' }, new Date());
      return own(member, current.id, client);
    });
    return answer(c, row);
  });

  app.get('/exports/:id/archive', async (c) => {
    const member = await requireMember(c, auth, pool);
    // A browser downloads from the user-content address once one is set (DOR-2957).
    if (config.userContentUrl) {
      if (!(await readyExport(pool, c.req.param('id'), member)))
        throw new ApiError(404, 'NOT_FOUND', 'Archive not found.');
      const link = await signLinkForSession(
        c,
        { auth, config, now: new Date() },
        { kind: 'export', id: c.req.param('id'), member }
      );
      c.header('Cache-Control', 'no-store');
      return c.redirect(link.url, 303);
    }
    return streamExportArchive(
      { pool, blobStore },
      {
        id: c.req.param('id'),
        member,
        stillMember: async () =>
          (await requireMember(c, auth, pool).catch(() => null))?.id === member.id,
        request: c.req.raw,
      }
    );
  });

  // A signed link a browser downloads the export from (DOR-2957), for a ready one of its own.
  app.post('/exports/:id/link', async (c) => {
    const member = await requireMember(c, auth, pool);
    if (!(await readyExport(pool, c.req.param('id'), member)))
      throw new ApiError(404, 'NOT_FOUND', 'Archive not found.');
    const link = await signLinkForSession(
      c,
      { auth, config, now: new Date() },
      { kind: 'export', id: c.req.param('id'), member }
    );
    c.header('Cache-Control', 'no-store');
    return json(c, UserContentLinkResponseSchema, {
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
    });
  });
}

/** Whether `member` asked for this export and it is ready to download. */
async function readyExport(pool: Pool, id: string, member: Member): Promise<boolean> {
  const ready = await pool.query(
    `SELECT 1 FROM export_archives WHERE id=$1 AND requester_member_id=$2 AND community_id=$3
       AND state='ready' AND deleted_at IS NULL AND expires_at>now()`,
    [id, member.id, member.community_id]
  );
  return Boolean(ready.rowCount);
}
