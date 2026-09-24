import type { PoolClient } from 'pg';
import type {
  CommunityWireExport,
  CommunityWireExportFailureCode,
} from '@dorkos/shared/community-wire';
import { queueBlobs } from '../content-removal.js';
import type { ExportScope } from './authority.js';

/** Columns of one `export_archives` row the routes and the worker read. */
export interface ExportRow {
  id: string;
  community_id: string;
  requester_member_id: string;
  scope: ExportScope;
  format_version: 1 | 2;
  state: 'queued' | 'building' | 'ready' | 'failed' | 'cancelled';
  blob_key: string | null;
  byte_size: string | null;
  created_at: Date;
  ready_at: Date | null;
  expires_at: Date | null;
  deleted_at: Date | null;
  failure_code: string | null;
  progress_done: string;
  progress_total: string | null;
  watermark: Record<string, number> | null;
  last_checked_redaction_id: string | null;
  verified_content_version: string | null;
  rebuild_passes: number;
  data_complete: boolean;
  attempts: number;
  failures: number;
  /** Time workers have spent on the job before this claim, in milliseconds. */
  run_ms: string;
}

/** The `export_archives` columns every read selects. */
export const EXPORT_COLUMNS = `id,community_id,requester_member_id,scope,format_version,state,blob_key,
  byte_size::text,created_at,ready_at,expires_at,deleted_at,failure_code,progress_done::text,
  progress_total::text,watermark,last_checked_redaction_id::text,
  verified_content_version::text,rebuild_passes,data_complete,attempts,failures,run_ms::text`;

/** Failure codes the wire names; anything else recorded reads as a storage failure. */
const WIRE_FAILURES = new Set<string>([
  'EXPORT_TIMED_OUT',
  'EXPORT_ACCESS_ENDED',
  'EXPORT_CONTENT_CHANGING',
  'EXPORT_STORAGE_UNAVAILABLE',
]);

/** Project one row as its requester sees it; a ready archive past its lifetime reads `expired`. */
export function toWireExport(row: ExportRow, now: Date): CommunityWireExport {
  const expired =
    row.state === 'ready' &&
    (row.deleted_at !== null || (row.expires_at !== null && row.expires_at <= now));
  return {
    id: row.id,
    scope: row.scope,
    state: expired ? 'expired' : row.state,
    progress: {
      done: Number(row.progress_done),
      total: row.progress_total === null ? null : Number(row.progress_total),
    },
    byteSize: row.state === 'ready' && row.byte_size !== null ? Number(row.byte_size) : null,
    failureCode:
      row.failure_code === null
        ? null
        : ((WIRE_FAILURES.has(row.failure_code)
            ? row.failure_code
            : 'EXPORT_STORAGE_UNAVAILABLE') as CommunityWireExportFailureCode),
    createdAt: row.created_at.toISOString(),
    readyAt: row.state === 'ready' ? (row.ready_at ?? row.created_at).toISOString() : null,
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}

/**
 * Delete an export's segment rows (all, or only some kinds) and queue their blobs, in the
 * caller's transaction. The rows go with the queueing: a segment row that still named its blob
 * would keep the pending-deletion sweep from removing it.
 */
export async function dropSegments(
  client: PoolClient,
  exportId: string,
  communityId: string,
  kinds: readonly ('data' | 'collection' | 'tail')[] = ['data', 'collection', 'tail']
): Promise<number> {
  const deleted = await client.query<{ blob_key: string }>(
    `DELETE FROM export_segments WHERE export_id=$1 AND community_id=$2 AND kind=ANY($3::text[])
     RETURNING blob_key`,
    [exportId, communityId, kinds]
  );
  await queueBlobs(
    client,
    communityId,
    deleted.rows.map((row) => row.blob_key)
  );
  return deleted.rows.length;
}

/**
 * End a job that is still queued or building, as failed (with a code) or cancelled, and queue
 * every segment it wrote. Returns false when the job had already ended.
 */
export async function endExportJob(
  client: PoolClient,
  exportId: string,
  outcome: { state: 'failed'; code: string } | { state: 'cancelled' },
  now: Date,
  fence?: number
): Promise<boolean> {
  const updated = await client.query<{ community_id: string }>(
    `UPDATE export_archives
     SET state=$2,failure_code=$3,ended_at=$4,lease_until=NULL
     WHERE id=$1 AND state IN ('queued','building') AND ($5::int IS NULL OR attempts=$5)
     RETURNING community_id`,
    [exportId, outcome.state, outcome.state === 'failed' ? outcome.code : null, now, fence ?? null]
  );
  const row = updated.rows[0];
  if (!row) return false;
  await dropSegments(client, exportId, row.community_id);
  return true;
}

/**
 * Delete every ready archive of a community, queueing its blobs first (a version 2 archive's
 * segments cascade away with the row, so their keys are read before it goes). Erasure and host
 * takedowns use this: a ready archive holds content they must remove.
 */
export async function deleteReadyExports(client: PoolClient, communityId: string): Promise<void> {
  const ready = await client.query<{ id: string; blob_key: string | null }>(
    `SELECT id,blob_key FROM export_archives
     WHERE community_id=$1 AND state='ready' AND deleted_at IS NULL FOR UPDATE`,
    [communityId]
  );
  const ids = ready.rows.map((row) => row.id);
  if (!ids.length) return;
  const segments = await client.query<{ blob_key: string }>(
    'SELECT blob_key FROM export_segments WHERE community_id=$1 AND export_id=ANY($2::uuid[])',
    [communityId, ids]
  );
  await queueBlobs(client, communityId, [
    ...ready.rows.flatMap((row) => (row.blob_key ? [row.blob_key] : [])),
    ...segments.rows.map((row) => row.blob_key),
  ]);
  await client.query('DELETE FROM export_archives WHERE community_id=$1 AND id=ANY($2::uuid[])', [
    communityId,
    ids,
  ]);
}

/**
 * Send every job of a community that is still being prepared back to the start: queue the
 * segments it wrote, forget what it covered, and make it `queued` again. The change of state
 * fences a worker still running it, whose next write finds the job no longer its own.
 */
export async function restartExportJobs(client: PoolClient, communityId: string): Promise<void> {
  const open = await client.query<{ id: string }>(
    `SELECT id FROM export_archives
     WHERE community_id=$1 AND state IN ('queued','building') FOR UPDATE`,
    [communityId]
  );
  for (const job of open.rows) {
    await dropSegments(client, job.id, communityId);
    await client.query(
      'DELETE FROM export_archive_channels WHERE export_archive_id=$1 AND community_id=$2',
      [job.id, communityId]
    );
  }
  await client.query(
    `UPDATE export_archives
     SET state='queued',lease_until=NULL,next_attempt_at=now(),watermark=NULL,
         last_checked_redaction_id=NULL,verified_content_version=NULL,rebuild_passes=0,
         progress_done=0,progress_total=NULL,data_complete=false,run_ms=0
     WHERE community_id=$1 AND id=ANY($2::uuid[])`,
    [communityId, open.rows.map((row) => row.id)]
  );
}
