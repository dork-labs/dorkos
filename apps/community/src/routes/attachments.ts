import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  CommunityWireAttachmentUploadRequestSchema,
  CommunityWireAttachmentUploadResponseSchema,
  type CommunityWireAttachment,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import {
  assertPrincipalCurrentInTransaction,
  lockChannel,
  lockPrincipalAuthority,
  requireJoined,
  requirePrincipal,
  transaction,
} from '../data.js';
import { assertStorageRoom, assertStorageWithinLimit } from '../host/limits.js';
import { ApiError, json } from '../http.js';
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

interface AttachmentRow {
  id: string;
  channel_id: string;
  blob_key: string;
  display_name: string;
  content_type: string;
  byte_size: number;
  checksum: string;
  uploaded_at: Date;
  request_hash: string;
}

/** Public attachment metadata with no storage key or backend address. */
export function attachmentProjection(row: AttachmentRow): CommunityWireAttachment {
  return {
    id: row.id,
    name: row.display_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    checksum: row.checksum,
    createdAt: row.uploaded_at.toISOString(),
  };
}

/** Load metadata for a page of entries with one bounded database query. */
export async function attachmentsForEntries(
  client: PoolClient | Pool,
  ids: string[]
): Promise<Map<string, CommunityWireAttachment[]>> {
  const result = ids.length
    ? await client.query<AttachmentRow & { entry_id: string }>(
        'SELECT id,entry_id,channel_id,blob_key,display_name,content_type,byte_size,checksum,uploaded_at,request_hash FROM attachments WHERE entry_id=ANY($1::uuid[]) ORDER BY uploaded_at,id',
        [ids]
      )
    : { rows: [] };
  const map = new Map<string, CommunityWireAttachment[]>();
  for (const row of result.rows) {
    const list = map.get(row.entry_id) ?? [];
    list.push(attachmentProjection(row));
    map.set(row.entry_id, list);
  }
  return map;
}

function mapBlobError(error: unknown): never {
  if (error instanceof BlobStoreError) {
    if (error.code === 'BLOB_TOO_LARGE')
      throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'The file is too large.');
    if (error.code === 'BLOB_TYPE_REJECTED' || error.code === 'BLOB_EMPTY')
      throw new ApiError(415, 'UNSUPPORTED_ATTACHMENT_TYPE', 'This file type is not supported.');
    if (error.code === 'BLOB_NOT_FOUND') throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  }
  throw error;
}

function uploadHeaders(c: Context) {
  const encodedName = c.req.header('x-file-name');
  if (!encodedName || encodedName.length > 720 || !/^(?:[\x21-\x7e])+$/.test(encodedName)) {
    throw new ApiError(400, 'STATE_CONFLICT', 'A valid encoded file name is required.');
  }
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new ApiError(400, 'STATE_CONFLICT', 'The file name encoding is invalid.');
  }
  const rawSize = c.req.header('x-file-size');
  if (!rawSize || !/^(0|[1-9]\d{0,8})$/.test(rawSize))
    throw new ApiError(400, 'STATE_CONFLICT', 'A valid file size is required.');
  const parsed = CommunityWireAttachmentUploadRequestSchema.safeParse({
    name,
    contentType: c.req.header('content-type'),
    byteSize: Number(rawSize),
    idempotencyKey: c.req.header('idempotency-key'),
  });
  if (!parsed.success) throw new ApiError(400, 'STATE_CONFLICT', 'Upload headers are invalid.');
  return parsed.data;
}

async function* requestBytes(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Delete a bounded page of old unbound blobs, leaving failures available for retry. */
export async function sweepExpiredAttachments(
  pool: Pool,
  blobStore: BlobStore,
  { batchSize = 50, olderThan = new Date(Date.now() - 60 * 60_000) } = {}
): Promise<{ deleted: number; failed: number }> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error('Invalid attachment sweep batch size');
  const candidates = await pool.query<{ id: string }>(
    'SELECT id FROM attachments WHERE entry_id IS NULL AND uploaded_at<$1 AND cleanup_next_attempt_at<=now() ORDER BY cleanup_next_attempt_at,uploaded_at,id LIMIT $2',
    [olderThan, batchSize]
  );
  let deleted = 0;
  let failed = 0;
  for (const candidate of candidates.rows) {
    const attempt: { outcome: 'deleted' | 'failed' | 'skipped'; error?: unknown } = {
      outcome: 'skipped',
    };
    try {
      await transaction(pool, async (client) => {
        const result = await client.query<{ blob_key: string }>(
          'SELECT blob_key FROM attachments WHERE id=$1 AND entry_id IS NULL AND uploaded_at<$2 AND cleanup_next_attempt_at<=now() FOR UPDATE',
          [candidate.id, olderThan]
        );
        if (!result.rows[0]) return;
        try {
          await blobStore.delete(result.rows[0].blob_key);
        } catch (error) {
          await client.query(
            `UPDATE attachments
             SET cleanup_attempts=cleanup_attempts+1,cleanup_next_attempt_at=now() + ${cleanupBackoffSql('cleanup_attempts')}
             WHERE id=$1 AND entry_id IS NULL AND uploaded_at<$2`,
            [candidate.id, olderThan]
          );
          attempt.outcome = 'failed';
          attempt.error = error;
          return;
        }
        // content-change: unposted-upload-sweep
        await client.query('DELETE FROM attachments WHERE id=$1 AND entry_id IS NULL', [
          candidate.id,
        ]);
        await client.query('DELETE FROM managed_blobs WHERE blob_key=$1', [
          result.rows[0].blob_key,
        ]);
        attempt.outcome = 'deleted';
      });
    } catch (error) {
      failed++;
      console.error('Community attachment cleanup failed', {
        attachmentId: candidate.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
      continue;
    }
    if (attempt.outcome === 'deleted') {
      deleted++;
    } else if (attempt.outcome === 'failed') {
      failed++;
      console.error('Community attachment cleanup failed', {
        attachmentId: candidate.id,
        error: attempt.error instanceof Error ? attempt.error.name : 'unknown',
      });
    }
  }
  return { deleted, failed };
}

/** Register streamed upload and live-authorized file download. */
export function registerAttachmentRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    blobStore,
  }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig; blobStore: BlobStore }
) {
  app.post('/channels/:id/attachments', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'post');
    const openedSession = principal.credentialHash
      ? null
      : await auth.api.getSession({ headers: c.req.raw.headers });
    if (!principal.credentialHash && !openedSession)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const metadata = uploadHeaders(c);
    if (metadata.byteSize > config.limits.attachmentBytes)
      throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'The file is too large.');
    const declaredLength = c.req.header('content-length');
    if (declaredLength && Number(declaredLength) !== metadata.byteSize)
      throw new ApiError(400, 'STATE_CONFLICT', 'The declared file size does not match.');
    if (!c.req.raw.body) throw new ApiError(400, 'STATE_CONFLICT', 'File bytes are required.');
    // Refuse on the declared size before a person uploads a file that cannot fit. A retry of an
    // upload that already landed skips this, so it still gets its original receipt.
    const uploaderField = principal.kind === 'agent' ? 'uploader_agent_id' : 'uploader_member_id';
    const landed = await pool.query(
      `SELECT 1 FROM attachments WHERE ${uploaderField}=$1 AND channel_id=$2 AND idempotency_key=$3`,
      [principal.id, c.req.param('id'), metadata.idempotencyKey]
    );
    if (!landed.rowCount) await assertStorageRoom(pool, principal.community_id, metadata.byteSize);
    const reservation = await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), principal);
      requireJoined(channel);
      if (channel.archived) throw new ApiError(409, 'STATE_CONFLICT', 'This channel is archived.');
      await lockPrincipalAuthority(client, principal);
      return reserveManagedBlob(client, principal.community_id, 'attachment');
    });
    let stored;
    try {
      stored = await blobStore.put({
        key: reservation.key,
        source: requestBytes(c.req.raw.body),
        displayName: metadata.name,
        maxBytes: config.limits.attachmentBytes,
        signal: managedBlobWriteSignal(c.req.raw.signal),
      });
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation).catch(() => undefined);
      mapBlobError(error);
    }
    if (stored.byteSize !== metadata.byteSize) {
      await discardManagedBlob(pool, blobStore, reservation, stored);
      throw new ApiError(400, 'STATE_CONFLICT', 'The file size does not match its bytes.');
    }
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([metadata.name, metadata.contentType, metadata.byteSize, stored.sha256])
      )
      .digest('hex');
    try {
      const result = await transaction(pool, async (client) => {
        const channel = await lockChannel(client, c.req.param('id'), principal);
        requireJoined(channel);
        if (channel.archived)
          throw new ApiError(409, 'STATE_CONFLICT', 'This channel is archived.');
        await lockPrincipalAuthority(client, principal);
        await assertPrincipalCurrentInTransaction(
          client,
          principal,
          'post',
          openedSession?.session.id
        );
        const field = principal.kind === 'agent' ? 'uploader_agent_id' : 'uploader_member_id';
        const prior = await client.query<AttachmentRow>(
          `SELECT * FROM attachments WHERE ${field}=$1 AND channel_id=$2 AND idempotency_key=$3`,
          [principal.id, channel.id, metadata.idempotencyKey]
        );
        if (prior.rows[0]) {
          if (prior.rows[0].request_hash !== requestHash)
            throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was used for another file.');
          return { attachment: attachmentProjection(prior.rows[0]), repeated: true };
        }
        const window = new Date();
        window.setUTCHours(0, 0, 0, 0);
        const quota = await client.query<{ upload_bytes: string }>(
          `INSERT INTO owner_quota_windows(community_id,owner_member_id,window_start,upload_bytes) VALUES($1,$2,$3,$4)
           ON CONFLICT(owner_member_id,window_start) DO UPDATE SET upload_bytes=owner_quota_windows.upload_bytes+EXCLUDED.upload_bytes
           WHERE owner_quota_windows.upload_bytes+EXCLUDED.upload_bytes<=$5 RETURNING upload_bytes`,
          [
            principal.community_id,
            principal.ownerMemberId,
            window,
            stored.byteSize,
            config.limits.uploadBytesPerDay,
          ]
        );
        if (!quota.rowCount) throw new ApiError(429, 'RATE_LIMITED', 'Daily upload limit reached.');
        await prepareManagedBlobCommit(client, reservation, stored);
        await assertStorageWithinLimit(client, principal.community_id, stored.byteSize);
        const inserted = await client.query<AttachmentRow>(
          `INSERT INTO attachments(community_id,channel_id,uploader_member_id,uploader_agent_id,blob_key,display_name,content_type,byte_size,checksum,idempotency_key,request_hash)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            principal.community_id,
            channel.id,
            principal.kind === 'human' ? principal.id : null,
            principal.kind === 'agent' ? principal.id : null,
            stored.key,
            stored.displayName,
            stored.contentType,
            stored.byteSize,
            stored.sha256,
            metadata.idempotencyKey,
            requestHash,
          ]
        );
        await completeManagedBlobCommit(client, reservation);
        return { attachment: attachmentProjection(inserted.rows[0]), repeated: false };
      });
      if (result.repeated) await discardManagedBlob(pool, blobStore, reservation, stored);
      return json(
        c,
        CommunityWireAttachmentUploadResponseSchema,
        { attachment: result.attachment },
        result.repeated ? 200 : 201
      );
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
  });

  app.get('/attachments/:id', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    const row = await pool.query<AttachmentRow>(
      'SELECT * FROM attachments WHERE id=$1 AND community_id=$2 AND entry_id IS NOT NULL',
      [c.req.param('id'), principal.community_id]
    );
    const attachment = row.rows[0];
    if (!attachment) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
    const authorize = async () => {
      const current = await requirePrincipal(c, auth, pool, 'read', false);
      if (current.kind !== principal.kind || current.id !== principal.id)
        throw new ApiError(403, 'FORBIDDEN', 'File access has ended.');
      const client = await pool.connect();
      try {
        const channel = await lockChannel(client, attachment.channel_id, current, 'read');
        requireJoined(channel);
        await lockPrincipalAuthority(client, current, 'read');
        // A file removed or taken down while it downloads stops at the next chunk: a held file's
        // bytes stay in storage for the evidence copy, so the stream alone would not end.
        const present = await client.query(
          'SELECT 1 FROM attachments WHERE id=$1 AND community_id=$2 AND entry_id IS NOT NULL',
          [attachment.id, principal.community_id]
        );
        if (!present.rowCount) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
      } finally {
        client.release();
      }
    };
    await authorize();
    let blob;
    try {
      blob = await blobStore.get(attachment.blob_key, { signal: c.req.raw.signal });
    } catch (error) {
      mapBlobError(error);
    }
    const iterator = blob.body[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          // The end of the stream carries no bytes, so access that ends after the last one went
          // out is not refused here. Refusing it errored a response the client had already read
          // in full (its content-length was met) and reset the connection under the client's
          // next request on it. Every chunk is still checked after it is read from storage and
          // before it is queued, so no chunk is read out after a failed check. The stream queues
          // one chunk ahead, so a chunk that passed its check just before access ended can still go.
          if (next.done) return controller.close();
          await authorize();
          controller.enqueue(next.value);
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
          displayName: attachment.display_name,
          contentType: attachment.content_type,
        }),
        'content-length': String(blob.byteSize),
        'cache-control': 'private, no-store',
      },
    });
  });
}
