import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Zip, ZipPassThrough } from 'fflate';
import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireExportResponseSchema,
  CommunityWireOwnerExportRequestSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import { requireMember, transaction, type Member } from '../data.js';
import { ApiError, json, readJson } from '../http.js';
import {
  BlobStoreError,
  completeManagedBlobCommit,
  discardManagedBlob,
  downloadHeaders,
  managedBlobWriteSignal,
  prepareManagedBlobCommit,
  reserveManagedBlob,
  type BlobStore,
} from '../storage/index.js';
import { cleanupBackoffSql } from '../storage/pending-deletions.js';

const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10_000;

interface AttachmentRecord {
  id: string;
  channel_id: string;
  entry_id: string;
  uploader_member_id: string | null;
  uploader_agent_id: string | null;
  blob_key: string;
  display_name: string;
  content_type: string;
  byte_size: number;
  checksum: string;
  uploaded_at: Date;
}

interface ExportArchiveRow {
  id: string;
  requester_member_id: string;
  scope: 'personal' | 'owner';
  channel_ids: string[];
  blob_key: string;
  byte_size: string;
  created_at: Date;
  expires_at: Date;
}

async function snapshot(pool: Pool | PoolClient, member: Member, scope: 'personal' | 'owner') {
  const owner = scope === 'owner';
  const channels = await pool.query(
    owner
      ? 'SELECT id,name,description,visibility,archived,created_at FROM channels WHERE community_id=$1 ORDER BY id LIMIT $2'
      : `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at FROM channels c
         WHERE c.community_id=$3 AND (
           EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.member_id=$1)
           OR EXISTS (
             SELECT 1 FROM agent_channel_members acm JOIN agents a ON a.id=acm.agent_id
             JOIN members owner ON owner.id=a.owner_member_id
             WHERE acm.channel_id=c.id AND a.owner_member_id=$1 AND a.active AND owner.active
           )
         ) ORDER BY c.id LIMIT $2`,
    owner ? [member.community_id, MAX_ROWS + 1] : [member.id, MAX_ROWS + 1, member.community_id]
  );
  const accessibleChannelIds = channels.rows.map((channel: { id: string }) => channel.id);
  const members = await pool.query(
    owner
      ? `SELECT m.id,m.display_name,m.handle,m.role,m.active,m.created_at,m.removed_at,u.email
         FROM members m JOIN "user" u ON u.id=m.user_id WHERE m.community_id=$1 ORDER BY m.id LIMIT $2`
      : `SELECT m.id,m.display_name,m.handle,m.role,m.active,m.created_at,m.removed_at,u.email
         FROM members m JOIN "user" u ON u.id=m.user_id WHERE m.id=$1 LIMIT $2`,
    [owner ? member.community_id : member.id, MAX_ROWS + 1]
  );
  const agents = await pool.query(
    `SELECT id,owner_member_id,display_name,handle,active,created_at,revoked_at
     FROM agents WHERE ${owner ? 'community_id' : 'owner_member_id'}=$1 ORDER BY id LIMIT $2`,
    [owner ? member.community_id : member.id, MAX_ROWS + 1]
  );
  const entries = await pool.query(
    owner
      ? `SELECT e.id,e.channel_id,e.seq,e.author_member_id,e.author_agent_id,e.author_display_name,e.text,COALESCE((SELECT array_agg(COALESCE(em.mentioned_member_id,em.mentioned_agent_id) ORDER BY em.position) FROM entry_mentions em WHERE em.entry_id=e.id),'{}'::uuid[]) AS mentions,e.parent_entry_id,e.thread_root_entry_id,e.created_at
         FROM entries e JOIN channels c ON c.id=e.channel_id WHERE c.community_id=$1 ORDER BY e.channel_id,e.seq LIMIT $2`
      : `SELECT e.id,e.channel_id,e.seq,e.author_member_id,e.author_agent_id,e.author_display_name,e.text,COALESCE((SELECT array_agg(COALESCE(em.mentioned_member_id,em.mentioned_agent_id) ORDER BY em.position) FROM entry_mentions em WHERE em.entry_id=e.id),'{}'::uuid[]) AS mentions,e.parent_entry_id,e.thread_root_entry_id,e.created_at
         FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id
         WHERE e.channel_id=ANY($3::uuid[]) AND (e.author_member_id=$1 OR a.owner_member_id=$1)
         ORDER BY e.channel_id,e.seq LIMIT $2`,
    owner ? [member.community_id, MAX_ROWS + 1] : [member.id, MAX_ROWS + 1, accessibleChannelIds]
  );
  const attachments = await pool.query<AttachmentRecord>(
    owner
      ? `SELECT att.* FROM attachments att JOIN channels c ON c.id=att.channel_id
         WHERE c.community_id=$1 AND att.entry_id IS NOT NULL ORDER BY att.id LIMIT $2`
      : `SELECT att.* FROM attachments att JOIN entries e ON e.id=att.entry_id
         LEFT JOIN agents a ON a.id=e.author_agent_id
         WHERE e.channel_id=ANY($3::uuid[]) AND (e.author_member_id=$1 OR a.owner_member_id=$1)
         ORDER BY att.id LIMIT $2`,
    owner ? [member.community_id, MAX_ROWS + 1] : [member.id, MAX_ROWS + 1, accessibleChannelIds]
  );
  for (const result of [channels, members, agents, entries, attachments]) {
    if (result.rows.length > MAX_ROWS)
      throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'This export exceeds the archive limit.');
  }
  const totalBytes = attachments.rows.reduce((sum, row) => sum + row.byte_size, 0);
  if (totalBytes > MAX_EXPORT_BYTES - MAX_MANIFEST_BYTES)
    throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'This export exceeds the archive limit.');
  const manifest = {
    version: 1,
    scope,
    requesterMemberId: member.id,
    channels: channels.rows,
    members: members.rows,
    agents: agents.rows,
    entries: entries.rows,
    attachments: attachments.rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      entryId: row.entry_id,
      uploaderMemberId: row.uploader_member_id,
      uploaderAgentId: row.uploader_agent_id,
      name: row.display_name,
      contentType: row.content_type,
      byteSize: row.byte_size,
      checksum: row.checksum,
      uploadedAt: row.uploaded_at,
      archivePath: `attachments/${row.id}`,
    })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES)
    throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'This export exceeds the archive limit.');
  return {
    manifestBytes,
    attachments: attachments.rows,
    channelIds: channels.rows.map((channel: { id: string }) => channel.id),
  };
}

async function requireCurrentChannels(
  pool: Pool | PoolClient,
  memberId: string,
  channelIds: string[]
) {
  if (!channelIds.length) return;
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM channels c
     WHERE c.id=ANY($2::uuid[]) AND (
       EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.member_id=$1)
       OR EXISTS (
         SELECT 1 FROM agent_channel_members acm JOIN agents a ON a.id=acm.agent_id
         JOIN members owner ON owner.id=a.owner_member_id
         WHERE acm.channel_id=c.id AND a.owner_member_id=$1 AND a.active AND owner.active
       )
     )`,
    [memberId, channelIds]
  );
  if (Number(result.rows[0].count) !== channelIds.length)
    throw new ApiError(403, 'FORBIDDEN', 'Export access has ended.');
}

function zipSource(
  manifestBytes: Uint8Array,
  attachments: AttachmentRecord[],
  blobStore: BlobStore
): AsyncIterable<Uint8Array> {
  const output = new PassThrough({ highWaterMark: 64 * 1024 });
  const zip = new Zip();
  zip.ondata = (error, chunk, final) => {
    if (error) output.destroy(error);
    else if (chunk.length) output.write(chunk);
    if (final) output.end();
  };
  const drain = async () => {
    if (output.writableNeedDrain) await once(output, 'drain');
  };
  void (async () => {
    try {
      const manifest = new ZipPassThrough('manifest.json');
      zip.add(manifest);
      manifest.push(manifestBytes, true);
      await drain();
      for (const attachment of attachments) {
        const file = new ZipPassThrough(`attachments/${attachment.id}`);
        zip.add(file);
        const blob = await blobStore.get(attachment.blob_key);
        try {
          for await (const chunk of blob.body) {
            file.push(chunk, false);
            await drain();
          }
          file.push(new Uint8Array(), true);
          await drain();
        } finally {
          blob.body.destroy();
        }
      }
      zip.end();
    } catch (error) {
      output.destroy(error instanceof Error ? error : new Error('Archive creation failed'));
    }
  })();
  return output;
}

/** Reclaim expired private archives while keeping failures available for retry. */
export async function sweepExpiredExports(pool: Pool, blobStore: BlobStore, batchSize = 25) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error('Invalid export sweep batch size');
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM export_archives WHERE deleted_at IS NULL AND expires_at<now() AND cleanup_next_attempt_at<=now() ORDER BY cleanup_next_attempt_at,expires_at,id LIMIT $1',
    [batchSize]
  );
  let deleted = 0;
  let failed = 0;
  for (const row of result.rows) {
    const attempt: { outcome: 'deleted' | 'failed' | 'skipped'; error?: unknown } = {
      outcome: 'skipped',
    };
    try {
      await transaction(pool, async (client) => {
        const current = await client.query<{ blob_key: string; community_id: string }>(
          `SELECT e.blob_key,m.community_id FROM export_archives e
           JOIN members m ON m.id=e.requester_member_id
           WHERE e.id=$1 AND e.deleted_at IS NULL AND e.expires_at<now() AND e.cleanup_next_attempt_at<=now() FOR UPDATE OF e`,
          [row.id]
        );
        if (!current.rows[0]) return;
        try {
          await blobStore.delete(current.rows[0].blob_key);
        } catch (error) {
          await client.query(
            `UPDATE export_archives
             SET cleanup_attempts=cleanup_attempts+1,cleanup_next_attempt_at=now() + ${cleanupBackoffSql('cleanup_attempts')}
             WHERE id=$1 AND deleted_at IS NULL AND expires_at<now()`,
            [row.id]
          );
          attempt.outcome = 'failed';
          attempt.error = error;
          return;
        }
        await client.query('UPDATE export_archives SET deleted_at=now() WHERE id=$1', [row.id]);
        await client.query('DELETE FROM managed_blobs WHERE blob_key=$1', [
          current.rows[0].blob_key,
        ]);
        await client.query(
          'INSERT INTO audit_events(community_id,action,subject_id) VALUES($1,$2,$3)',
          [current.rows[0].community_id, 'export.expire', row.id]
        );
        attempt.outcome = 'deleted';
      });
    } catch (error) {
      failed++;
      console.error('Community export cleanup failed', {
        archiveId: row.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
      continue;
    }
    if (attempt.outcome === 'deleted') {
      deleted++;
    } else if (attempt.outcome === 'failed') {
      failed++;
      console.error('Community export cleanup failed', {
        archiveId: row.id,
        error: attempt.error instanceof Error ? attempt.error.name : 'unknown',
      });
    }
  }
  return { deleted, failed };
}

/** Register personal and reauthenticated owner exports and their private downloads. */
export function registerExportRoutes(
  app: Hono,
  { pool, auth, blobStore }: { pool: Pool; auth: CommunityAuth; blobStore: BlobStore }
) {
  const create = async (member: Member, scope: 'personal' | 'owner') => {
    const currentResult = await pool.query<Member>(
      'SELECT id,user_id,display_name,role,community_id FROM members WHERE id=$1 AND active',
      [member.id]
    );
    const current = currentResult.rows[0];
    if (!current) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
    if (scope === 'owner' && current.role !== 'owner')
      throw new ApiError(403, 'FORBIDDEN', 'Only the owner can export the community.');
    const data = await transaction(pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return snapshot(client, current, scope);
    });
    const reservation = await transaction(pool, (client) =>
      reserveManagedBlob(client, current.community_id, 'export')
    );
    let stored;
    try {
      stored = await blobStore.put({
        key: reservation.key,
        source: zipSource(data.manifestBytes, data.attachments, blobStore),
        displayName: scope === 'owner' ? 'community-export.zip' : 'my-community-data.zip',
        maxBytes: MAX_EXPORT_BYTES,
        kind: 'export',
        signal: managedBlobWriteSignal(),
      });
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation).catch(() => undefined);
      if (error instanceof BlobStoreError && error.code === 'BLOB_TOO_LARGE')
        throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'This export exceeds the archive limit.');
      throw error;
    }
    try {
      return await transaction(pool, async (client) => {
        await prepareManagedBlobCommit(client, reservation, stored);
        const live = await client.query<Member>(
          'SELECT id,user_id,display_name,role,community_id FROM members WHERE id=$1 AND active FOR SHARE',
          [member.id]
        );
        if (!live.rows[0] || (scope === 'owner' && live.rows[0].role !== 'owner'))
          throw new ApiError(403, 'FORBIDDEN', 'Export access has ended.');
        if (scope === 'personal') await requireCurrentChannels(client, member.id, data.channelIds);
        const result = await client.query<Omit<ExportArchiveRow, 'channel_ids'>>(
          `INSERT INTO export_archives(community_id,requester_member_id,scope,blob_key,byte_size,expires_at)
           VALUES($1,$2,$3,$4,$5,now()+interval '1 hour') RETURNING *`,
          [member.community_id, member.id, scope, stored.key, stored.byteSize]
        );
        await client.query(
          `INSERT INTO export_archive_channels(export_archive_id,position,community_id,channel_id)
           SELECT $1,selected.position,$2,selected.channel_id
           FROM unnest($3::uuid[]) WITH ORDINALITY AS selected(channel_id,position)`,
          [result.rows[0].id, member.community_id, data.channelIds]
        );
        await client.query(
          'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
          [member.community_id, member.id, 'export.create', result.rows[0].id]
        );
        await completeManagedBlobCommit(client, reservation);
        return { ...result.rows[0], channel_ids: data.channelIds };
      });
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation, stored).catch(
        (cleanupError: unknown) => {
          console.error(
            'Community blob cleanup could not be queued',
            cleanupError instanceof Error ? cleanupError.name : 'unknown'
          );
        }
      );
      throw error;
    }
  };
  app.post('/api/v1/me/export', async (c) => {
    const member = await requireMember(c, auth, pool);
    const archive = await create(member, 'personal');
    return json(
      c,
      CommunityWireExportResponseSchema,
      {
        archiveId: archive.id,
        version: 1,
        createdAt: archive.created_at.toISOString(),
      },
      201
    );
  });

  app.post('/api/v1/owner/export', async (c) => {
    const member = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireOwnerExportRequestSchema);
    try {
      await auth.api.verifyPassword({
        headers: c.req.raw.headers,
        body: { password: body.password },
      });
    } catch {
      throw new ApiError(403, 'FORBIDDEN', 'Reauthentication failed.');
    }
    const archive = await create(member, 'owner');
    return json(
      c,
      CommunityWireExportResponseSchema,
      {
        archiveId: archive.id,
        version: 1,
        createdAt: archive.created_at.toISOString(),
      },
      201
    );
  });

  app.get('/api/v1/exports/:id', async (c) => {
    const member = await requireMember(c, auth, pool);
    const result = await pool.query<ExportArchiveRow>(
      `SELECT archive.*,
        COALESCE((SELECT array_agg(selected.channel_id ORDER BY selected.position)
          FROM export_archive_channels selected WHERE selected.export_archive_id=archive.id),'{}'::uuid[]) AS channel_ids
       FROM export_archives archive
       WHERE archive.id=$1 AND archive.requester_member_id=$2 AND archive.deleted_at IS NULL AND archive.expires_at>now()`,
      [c.req.param('id'), member.id]
    );
    const archive = result.rows[0];
    if (!archive) throw new ApiError(404, 'NOT_FOUND', 'Archive not found.');
    const live = await pool.query<Member>(
      'SELECT id,user_id,display_name,role,community_id FROM members WHERE id=$1 AND active',
      [member.id]
    );
    if (!live.rows[0] || (archive.scope === 'owner' && live.rows[0].role !== 'owner'))
      throw new ApiError(403, 'FORBIDDEN', 'Export access has ended.');
    if (archive.scope === 'personal')
      await requireCurrentChannels(pool, member.id, archive.channel_ids);
    const blob = await blobStore.get(archive.blob_key, { signal: c.req.raw.signal });
    const iterator = blob.body[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const current = await requireMember(c, auth, pool);
          if (current.id !== member.id || (archive.scope === 'owner' && current.role !== 'owner'))
            throw new ApiError(403, 'FORBIDDEN', 'Export access has ended.');
          if (archive.scope === 'personal')
            await requireCurrentChannels(pool, member.id, archive.channel_ids);
          const next = await iterator.next();
          const after = await requireMember(c, auth, pool);
          if (after.id !== member.id || (archive.scope === 'owner' && after.role !== 'owner'))
            throw new ApiError(403, 'FORBIDDEN', 'Export access has ended.');
          if (archive.scope === 'personal')
            await requireCurrentChannels(pool, member.id, archive.channel_ids);
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          blob.body.destroy();
          controller.error(error);
        }
      },
      async cancel() {
        blob.body.destroy();
        await iterator.return?.();
      },
    });
    return new Response(body, {
      headers: {
        ...downloadHeaders({
          displayName: archive.scope === 'owner' ? 'community-export.zip' : 'my-community-data.zip',
          contentType: 'application/zip',
        }),
        'content-length': String(blob.byteSize),
        'cache-control': 'private, no-store',
      },
    });
  });
}
