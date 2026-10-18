import type { Pool } from 'pg';
import {
  lockChannel,
  lockPrincipalAuthority,
  requireJoined,
  type Principal,
} from '../../../data.js';
import { ApiError } from '../../../http.js';
import { BlobStoreError, downloadHeaders, type BlobStore } from '../../../storage/index.js';

/** The attachment columns a download reads. */
interface DownloadRow {
  id: string;
  channel_id: string;
  blob_key: string;
  display_name: string;
  content_type: string;
}

/**
 * The posted file `principal` may read now: in their space, on a message, in a channel they
 * are in, with their own access to it current. Each check takes the same locks a read does.
 *
 * @returns The file's row.
 */
export async function readableAttachment(
  pool: Pool,
  attachmentId: string,
  principal: Principal
): Promise<DownloadRow> {
  const row = await pool.query<DownloadRow>(
    `SELECT id,channel_id,blob_key,display_name,content_type FROM attachments
     WHERE id=$1 AND community_id=$2 AND entry_id IS NOT NULL`,
    [attachmentId, principal.community_id]
  );
  const attachment = row.rows[0];
  if (!attachment) throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  const client = await pool.connect();
  try {
    const channel = await lockChannel(client, attachment.channel_id, principal, 'read', 'shared');
    requireJoined(channel);
    await lockPrincipalAuthority(client, principal, 'read');
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
  return attachment;
}

/**
 * Stream one posted file to whoever `current` says is asking, checking their access again before
 * every chunk. The space's own route passes the caller's cookie or bearer; a signed link passes
 * the person it was made for (DOR-2957). Either way access is the person's own, now.
 *
 * @param deps - The database and the file store.
 * @param target - The file, the space it must be in, and how to resolve the reader.
 * @returns The download response: the file's bytes as an attachment.
 */
export async function streamAttachment(
  { pool, blobStore }: { pool: Pool; blobStore: BlobStore },
  target: {
    attachmentId: string;
    communityId: string;
    /** Who is reading, resolved again before every chunk. */
    current: () => Promise<Principal>;
    signal: AbortSignal;
  }
): Promise<Response> {
  const principal = await target.current();
  if (principal.community_id !== target.communityId)
    throw new ApiError(404, 'NOT_FOUND', 'File not found.');
  const authorize = async () => {
    const current = await target.current();
    if (current.kind !== principal.kind || current.id !== principal.id)
      throw new ApiError(403, 'FORBIDDEN', 'File access has ended.');
    return readableAttachment(pool, target.attachmentId, current);
  };
  const attachment = await authorize();
  let blob;
  try {
    blob = await blobStore.get(attachment.blob_key, { signal: target.signal });
  } catch (error) {
    if (error instanceof BlobStoreError && error.code === 'BLOB_NOT_FOUND')
      throw new ApiError(404, 'NOT_FOUND', 'File not found.');
    throw error;
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
}
