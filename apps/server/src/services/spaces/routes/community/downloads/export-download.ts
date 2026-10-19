import type { Pool } from 'pg';
import { ApiError } from '../../../http.js';
import { downloadHeaders, type BlobStore } from '../../../storage/index.js';
import { SegmentedBlobSource, type ArchiveBlob } from '../../../archive/segmented-source.js';
import {
  exportRequesterOf,
  hasExportAuthority,
  type ExportRequester,
} from '../../../exports/authority.js';
import { EXPORT_COLUMNS, type ExportRow } from '../../../exports/store.js';

/** A download re-checks the requester's authority after at most this many bytes... */
export const DOWNLOAD_RECHECK_BYTES = 16 * 1024 * 1024;
/** ...or this much time, whichever comes first. */
export const DOWNLOAD_RECHECK_MS = 10_000;
/**
 * A download re-checks that its archive still exists after at most this many bytes... A
 * takedown or an erasure that deletes the archive stops the download within this window, while
 * a fast download makes one database round trip per window rather than one per chunk.
 */
export const ARCHIVE_RECHECK_BYTES = 256 * 1024;
/** ...or this much time, whichever comes first. */
export const ARCHIVE_RECHECK_MS = 250;

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

/** Who asked for an export, with the channels a personal one covers. */
export async function requesterOf(pool: Pool, row: ExportRow): Promise<ExportRequester> {
  const channels =
    row.scope === 'personal'
      ? await pool.query<{ channel_id: string }>(
          `SELECT channel_id FROM export_archive_channels
           WHERE export_archive_id=$1 AND community_id=$2 ORDER BY position`,
          [row.id, row.community_id]
        )
      : { rows: [] };
  return exportRequesterOf(
    row,
    channels.rows.map((channel) => channel.channel_id)
  );
}

/**
 * Stream a ready export archive to the person who asked for it, resumable by range, checking
 * again every few megabytes or seconds that they still may and that it still exists. The
 * space's own route passes the caller's sign-in; a signed link passes the person it was made for
 * (DOR-2957).
 *
 * @param deps - The database and the file store.
 * @param target - The export, its requester, whether they are still a member, and the request
 *   whose range headers and abort signal the download follows.
 * @returns The archive, whole (200), a range of it (206), or 416 for a range it cannot serve.
 */
export async function streamExportArchive(
  { pool, blobStore }: { pool: Pool; blobStore: BlobStore },
  target: {
    id: string;
    member: { id: string; community_id: string };
    /** Whether the requester is still signed in as that member. */
    stillMember: () => Promise<boolean>;
    request: Request;
  }
): Promise<Response> {
  const { id, member } = target;
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
  const ifRange = target.request.headers.get('if-range') ?? undefined;
  const range =
    ifRange === undefined || ifRange === etag
      ? parseByteRange(target.request.headers.get('range') ?? undefined, source.size)
      : null;
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${source.size}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? source.size - 1;
  // The requester's authority is re-checked every few megabytes or seconds.
  const stillAllowed = async () =>
    (await target.stillMember()) && (await hasExportAuthority(pool, requester));
  const iterator = source
    .read(start, end, { signal: target.request.signal })
    [Symbol.asyncIterator]();
  let sinceCheck = 0;
  let checkedAt = Date.now();
  let sinceArchiveCheck = 0;
  let archiveCheckedAt = checkedAt;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        // As a file download does, the end carries no bytes and is not refused, and a check runs
        // after a chunk is read and before it is queued. The archive row goes before its bytes
        // do, so an erasure or takedown that deletes the export stops the download here, within
        // one window, even while its segments still wait for the cleanup sweep.
        if (next.done) return controller.close();
        if (
          sinceArchiveCheck + next.value.length > ARCHIVE_RECHECK_BYTES ||
          Date.now() - archiveCheckedAt >= ARCHIVE_RECHECK_MS
        ) {
          if (!(await readyRow())) throw new ApiError(404, 'NOT_FOUND', 'Archive not found.');
          sinceArchiveCheck = 0;
          archiveCheckedAt = Date.now();
        }
        sinceArchiveCheck += next.value.length;
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
}
