import type { Context, Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireExportListSchema,
  CommunityWireExportResponseSchema,
  CommunityWireOwnerExportRequestSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import { lockActiveCommunity, requireMember, transaction, type Member } from '../data.js';
import type { ConfirmPassword } from '../password-confirmation.js';
import { ApiError, json, readJson } from '../http.js';
import { downloadHeaders, type BlobStore } from '../storage/index.js';
import { SegmentedBlobSource, type ArchiveBlob } from '../archive/segmented-source.js';
import {
  hasExportAuthority,
  OWNER_EXPORT_LIFECYCLES,
  type ExportRequester,
  type ExportScope,
} from '../exports/authority.js';
import { endExportJob, EXPORT_COLUMNS, toWireExport, type ExportRow } from '../exports/store.js';

/** A download re-checks its authority after at most this many bytes... */
export const DOWNLOAD_RECHECK_BYTES = 16 * 1024 * 1024;
/** ...or this much time, whichever comes first. */
export const DOWNLOAD_RECHECK_MS = 10_000;

/** Exports still open, or ended within the last week, are listed. */
const LISTED = `(state IN ('queued','building')
  OR (state='ready' AND COALESCE(deleted_at,expires_at)>now()-interval '7 days')
  OR (state IN ('failed','cancelled') AND ended_at>now()-interval '7 days'))`;

/**
 * Parse one `Range: bytes=...` header against a representation of `size` bytes (RFC 9110
 * §14.1.2). Returns the inclusive range, `'unsatisfiable'` (answer 416), or null to serve the
 * whole representation: no header, a syntax this server does not serve (several ranges, another
 * unit), or an invalid one.
 */
export function parseByteRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const last = match[2] === '' ? Number.MAX_SAFE_INTEGER : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last) || last < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(last, size - 1) };
}

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
    throw new ApiError(409, 'COMMUNITY_UNAVAILABLE', 'This community cannot be exported now.');
  const live = await client.query<{ role: Member['role'] }>(
    'SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
    [member.id, member.community_id]
  );
  if (!live.rows[0] || (scope === 'owner' && live.rows[0].role !== 'owner'))
    throw new ApiError(403, 'FORBIDDEN', 'Export access has ended.');
}

async function requesterOf(pool: Pool, row: ExportRow): Promise<ExportRequester> {
  const channels =
    row.scope === 'personal'
      ? await pool.query<{ channel_id: string }>(
          `SELECT channel_id FROM export_archive_channels
           WHERE export_archive_id=$1 AND community_id=$2 ORDER BY position`,
          [row.id, row.community_id]
        )
      : { rows: [] };
  return {
    communityId: row.community_id,
    memberId: row.requester_member_id,
    scope: row.scope,
    channelIds: channels.rows.map((channel) => channel.channel_id),
  };
}

/** Register export jobs, their status and cancellation, and the resumable archive download. */
export function registerExportRoutes(
  app: Hono,
  {
    pool,
    auth,
    blobStore,
    confirmPassword,
  }: {
    pool: Pool;
    auth: CommunityAuth;
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
      'SELECT id,user_id,display_name,role,community_id FROM members WHERE id=$1 AND community_id=$2 AND active',
      [member.id, member.community_id]
    );
    if (!current.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
    if (scope === 'owner' && current.rows[0].role !== 'owner')
      throw new ApiError(403, 'FORBIDDEN', 'Only the owner can export the community.');
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
         VALUES($1,$2,$3,2,'queued') RETURNING ${EXPORT_COLUMNS}`,
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
    const id = c.req.param('id');
    const readyRow = async (): Promise<ExportRow | null> => {
      const result = await pool.query<ExportRow>(
        `SELECT ${EXPORT_COLUMNS} FROM export_archives
         WHERE id=$1 AND requester_member_id=$2 AND community_id=$3
           AND state='ready' AND deleted_at IS NULL AND expires_at>now()`,
        [id, member.id, member.community_id]
      );
      return result.rows[0] ?? null;
    };
    const archive = await readyRow();
    if (!archive) throw new ApiError(404, 'NOT_FOUND', 'Archive not found.');
    const requester = await requesterOf(pool, archive);
    if (!(await hasExportAuthority(pool, requester)))
      throw new ApiError(403, 'FORBIDDEN', 'Export access has ended.');
    const blobs: ArchiveBlob[] = archive.blob_key
      ? [{ key: archive.blob_key, byteSize: Number(archive.byte_size) }]
      : (
          await pool.query<{ blob_key: string; byte_size: string }>(
            `SELECT blob_key,byte_size::text FROM export_segments
             WHERE export_id=$1 AND community_id=$2 ORDER BY segment_no`,
            [archive.id, archive.community_id]
          )
        ).rows.map((row) => ({ key: row.blob_key, byteSize: Number(row.byte_size) }));
    const source = new SegmentedBlobSource(blobStore, blobs);
    // Strong: a ready archive never changes, and a rebuilt one is a different export.
    const etag = `"${archive.id}.${(archive.ready_at ?? archive.created_at).getTime()}"`;
    const headers: Record<string, string> = {
      ...downloadHeaders({
        displayName: archive.scope === 'owner' ? 'community-export.zip' : 'my-community-data.zip',
        contentType: 'application/zip',
      }),
      'accept-ranges': 'bytes',
      etag,
      'cache-control': 'private, no-store',
    };
    const ifRange = c.req.header('if-range');
    const range =
      ifRange === undefined || ifRange === etag
        ? parseByteRange(c.req.header('range'), source.size)
        : null;
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${source.size}` },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? source.size - 1;
    // Re-check the requester and the archive row itself: an erasure or takedown that deletes
    // the export stops a download already in progress.
    const stillAllowed = async () => {
      const current = await requireMember(c, auth, pool).catch(() => null);
      return (
        current !== null &&
        current.id === member.id &&
        (await readyRow()) !== null &&
        (await hasExportAuthority(pool, requester))
      );
    };
    const iterator = source.read(start, end, { signal: c.req.raw.signal })[Symbol.asyncIterator]();
    let sinceCheck = 0;
    let checkedAt = Date.now();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) return controller.close();
          if (
            sinceCheck + next.value.length > DOWNLOAD_RECHECK_BYTES ||
            Date.now() - checkedAt >= DOWNLOAD_RECHECK_MS
          ) {
            if (!(await stillAllowed()))
              throw new ApiError(403, 'FORBIDDEN', 'Export access has ended.');
            sinceCheck = 0;
            checkedAt = Date.now();
          }
          sinceCheck += next.value.length;
          controller.enqueue(next.value);
        } catch (error) {
          await iterator.return?.(undefined);
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.(undefined);
      },
    });
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        'content-length': String(end - start + 1),
        ...(range ? { 'content-range': `bytes ${start}-${end}/${source.size}` } : {}),
      },
    });
  });
}
