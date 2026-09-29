import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CommunityEvidenceRecordV1Schema } from '@dorkos/shared/community-admin-wire';
import { releaseHeldBlobs } from '../content-removal.js';
import { transaction } from '../data.js';
import { serializeEvidenceRecord, type EvidenceRecord } from './evidence/record.js';
import { dropEvidenceExport, queueEvidenceExport } from './evidence-export.js';
import { EvidenceSinkError, evidenceAttemptFolder, type EvidenceSink } from './evidence/sink.js';
import { recordHostAudit } from '../host/authority.js';
import { BlobStoreError, type BlobStore } from '../storage/index.js';
import { cleanupBackoffSql } from '../storage/pending-deletions.js';

/** Failures in a row before the copy is `failed` and waits for a person to retry it. */
export const EVIDENCE_MAX_FAILURES = 5;
/** How long a claimed copy stays one worker's before another may take it over. */
const LEASE = "interval '5 minutes'";

/** Test seams inside one evidence attempt. */
export interface TakedownWorkerHooks {
  /** Runs after the held files are written and before record.json. Throwing fails the attempt. */
  beforeRecord?: () => Promise<void>;
}

/** How one sweep runs. */
export interface TakedownWorkerOptions {
  /** The worker's clock for the overdue alert. */
  now?: Date;
  /** Hours evidence may stay unsettled before the worker warns about it each hour. */
  alertHours: number;
  /** Receives each warning line; defaults to standard error. */
  warn?: (line: string) => void;
  hooks?: TakedownWorkerHooks;
}

/** A content-free class for a failed attempt: a storage code, never a message. */
function errorClass(error: unknown): string {
  if (error instanceof EvidenceSinkError || error instanceof BlobStoreError) return error.code;
  return 'EVIDENCE_WRITE_FAILED';
}

/**
 * Copy one due takedown's held evidence into the evidence store, if any is due.
 *
 * Attempt `n` streams each held file from primary storage into `takedowns/<id>/attempt-<n>/`,
 * checking every byte against the checksum recorded when the file was uploaded, then writes
 * `record.json` last, so its presence marks a complete attempt. Only then, in one transaction,
 * are the held bytes released to deletion, the staged record dropped, and the record's SHA-256
 * stored on the takedown and in a host audit row. A failed attempt keeps everything held and
 * tries again later, in a new attempt folder, so no attempt ever overwrites another.
 *
 * @returns Whether a takedown was claimed, and whether its copy was stored.
 */
export async function copyDueTakedownEvidence(
  pool: Pool,
  blobStore: BlobStore,
  sink: EvidenceSink,
  options: Pick<TakedownWorkerOptions, 'hooks' | 'warn'> = {}
): Promise<{ claimed: boolean; stored: boolean }> {
  const claim = await transaction(pool, async (client) => {
    const due = await client.query<{
      id: string;
      community_id: string;
      target_kind: string;
      evidence_export_id: string | null;
      evidence_attempts: number;
      lease_until: Date;
    }>(
      // The attempt number is taken with the claim, so two workers never share a folder. The
      // lease is in whole milliseconds, so the value read back into JavaScript matches the row.
      // A whole community's copy is not due while its evidence export is still being built.
      `UPDATE community_takedowns SET evidence_attempts=evidence_attempts+1,
         lease_until=date_trunc('milliseconds',now())+${LEASE}
       WHERE id=(
         SELECT t.id FROM community_takedowns t
         WHERE t.evidence_state IN ('pending','retrying') AND t.next_attempt_at<=now()
           AND (t.lease_until IS NULL OR t.lease_until<=now())
           AND NOT EXISTS (SELECT 1 FROM export_archives e
             WHERE e.id=t.evidence_export_id AND e.state IN ('queued','building'))
         ORDER BY t.next_attempt_at,t.id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id,community_id,target_kind,evidence_export_id,evidence_attempts,lease_until`
    );
    const row = due.rows[0];
    if (!row) return null;
    const staged = await client.query<{ record: unknown; blob_keys: string[] }>(
      'SELECT record,blob_keys FROM takedown_evidence_staging WHERE takedown_id=$1',
      [row.id]
    );
    return { ...row, staged: staged.rows[0] };
  });
  if (!claim) return { claimed: false, stored: false };
  const attempt = claim.evidence_attempts;
  const folder = evidenceAttemptFolder(claim.id, attempt);
  const community = claim.target_kind === 'community';
  let recordSha256: string;
  try {
    if (!claim.staged) throw new EvidenceSinkError('EVIDENCE_WRITE_FAILED');
    const record = CommunityEvidenceRecordV1Schema.parse(claim.staged.record);
    if (community) {
      record.archive = await copyEvidenceArchive(pool, blobStore, sink, claim, folder);
    }
    const held = [
      ...record.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        byteSize: file.byteSize,
      })),
      ...(record.icon
        ? [{ path: record.icon.path, sha256: record.icon.sha256, byteSize: record.icon.byteSize }]
        : []),
    ];
    if (held.length !== claim.staged.blob_keys.length)
      throw new EvidenceSinkError('EVIDENCE_WRITE_FAILED');
    for (const [index, file] of held.entries()) {
      const read = await blobStore.get(claim.staged.blob_keys[index]);
      try {
        await sink.put(`${folder}${file.path}`, read.body, {
          sha256: file.sha256,
          byteSize: file.byteSize,
        });
      } finally {
        read.body.destroy();
      }
    }
    await options.hooks?.beforeRecord?.();
    const bytes = serializeEvidenceRecord(record);
    recordSha256 = createHash('sha256').update(bytes).digest('hex');
    await sink.put(`${folder}record.json`, [bytes], {
      sha256: recordSha256,
      byteSize: bytes.length,
    });
  } catch (error) {
    const code = errorClass(error);
    await transaction(pool, async (client) => {
      // Only the attempt that still holds the lease records its failure: a copy released or
      // retried meanwhile is left as its new owner set it.
      const recorded = await client.query<{ evidence_state: string }>(
        `UPDATE community_takedowns SET
           evidence_failures=evidence_failures+1,last_error_class=$2,lease_until=NULL,
           evidence_state=CASE WHEN evidence_failures+1>=$3 THEN 'failed' ELSE 'retrying' END,
           next_attempt_at=CASE WHEN evidence_failures+1>=$3 THEN NULL
             ELSE now()+${cleanupBackoffSql('evidence_failures')} END
         WHERE id=$1 AND evidence_state IN ('pending','retrying') AND lease_until=$4
         RETURNING evidence_state`,
        [claim.id, code, EVIDENCE_MAX_FAILURES, claim.lease_until]
      );
      // An evidence export that failed cannot be copied: while tries remain, a new one is
      // built. One that is ready stays, and the next attempt copies it again.
      if (
        community &&
        code === 'EVIDENCE_EXPORT_FAILED' &&
        recorded.rows[0]?.evidence_state === 'retrying'
      ) {
        const takedown = { id: claim.id, communityId: claim.community_id };
        await dropEvidenceExport(client, takedown, new Date());
        await queueEvidenceExport(client, takedown);
      }
    });
    (options.warn ?? ((line: string) => console.warn(line)))(
      JSON.stringify({
        event: 'community.takedown.evidence_failed',
        takedownId: claim.id,
        communityId: claim.community_id,
        attempt,
        errorClass: code,
      })
    );
    return { claimed: true, stored: false };
  }
  const stored = await transaction(pool, async (client) => {
    const current = await client.query(
      `SELECT 1 FROM community_takedowns
       WHERE id=$1 AND evidence_state IN ('pending','retrying') AND lease_until=$2 FOR UPDATE`,
      [claim.id, claim.lease_until]
    );
    if (!current.rowCount) return false;
    const staged = await client.query<{ blob_keys: string[] }>(
      'DELETE FROM takedown_evidence_staging WHERE takedown_id=$1 RETURNING blob_keys',
      [claim.id]
    );
    await releaseHeldBlobs(client, claim.community_id, staged.rows[0]?.blob_keys ?? []);
    // The evidence export has done its job: its copy is in the store, and its segments go.
    if (community)
      await dropEvidenceExport(
        client,
        { id: claim.id, communityId: claim.community_id },
        new Date()
      );
    await client.query(
      `UPDATE community_takedowns SET evidence_state='stored',evidence_location=$2,
         evidence_record_sha256=$3,evidence_failures=0,
         next_attempt_at=NULL,lease_until=NULL,last_error_class=NULL
       WHERE id=$1`,
      [claim.id, folder, recordSha256]
    );
    await recordHostAudit(
      client,
      { kind: 'system' },
      {
        action: 'takedown.evidence_stored',
        communityId: claim.community_id,
        nextState: 'stored',
        changedFields: ['evidence'],
        evidenceRecordSha256: recordSha256,
      }
    );
    return true;
  });
  return { claimed: true, stored };
}

/**
 * Copy a whole-community takedown's finished evidence export into the attempt folder, one
 * segment at a time, in order, each checked against the SHA-256 its blob was stored with.
 *
 * @returns The record's `archive`: the segments as written, and how to read them.
 * @throws EvidenceSinkError `EVIDENCE_EXPORT_FAILED` when the export failed, was cancelled, is
 *   gone, or is missing a segment or a segment's blob: the caller then builds a new one.
 */
async function copyEvidenceArchive(
  pool: Pool,
  blobStore: BlobStore,
  sink: EvidenceSink,
  claim: { community_id: string; evidence_export_id: string | null },
  folder: string
): Promise<NonNullable<EvidenceRecord['archive']>> {
  const exported = await pool.query<{ state: string }>(
    `SELECT state FROM export_archives
     WHERE id=$1 AND community_id=$2 AND scope='evidence'`,
    [claim.evidence_export_id, claim.community_id]
  );
  if (exported.rows[0]?.state !== 'ready') throw new EvidenceSinkError('EVIDENCE_EXPORT_FAILED');
  // Every segment, with its blob's checksum if the blob is still committed. A segment whose
  // blob row is gone, or a gap in the numbering, means the archive is incomplete: copying the
  // rest would store a copy that looks whole and is not.
  const segments = await pool.query<{
    segment_no: number;
    blob_key: string;
    byte_size: string;
    checksum: string | null;
  }>(
    `SELECT s.segment_no,s.blob_key,s.byte_size::text,m.checksum FROM export_segments s
     LEFT JOIN managed_blobs m ON m.blob_key=s.blob_key AND m.community_id=s.community_id
       AND m.state='committed'
     WHERE s.export_id=$1 AND s.community_id=$2 ORDER BY s.segment_no`,
    [claim.evidence_export_id, claim.community_id]
  );
  if (segments.rows.some((segment, index) => segment.segment_no !== index + 1 || !segment.checksum))
    throw new EvidenceSinkError('EVIDENCE_EXPORT_FAILED');
  const written: NonNullable<EvidenceRecord['archive']>['segments'] = [];
  for (const [index, segment] of segments.rows.entries()) {
    const path = `archive.zip.${String(index + 1).padStart(6, '0')}`;
    const byteSize = Number(segment.byte_size);
    const read = await blobStore.get(segment.blob_key);
    try {
      await sink.put(`${folder}${path}`, read.body, { sha256: segment.checksum!, byteSize });
    } finally {
      read.body.destroy();
    }
    written.push({ path, byteSize, sha256: segment.checksum! });
  }
  if (!written.length) throw new EvidenceSinkError('EVIDENCE_EXPORT_FAILED');
  return {
    format: 'zip64',
    manifestVersion: 2,
    segments: written,
    byteSize: written.reduce((sum, segment) => sum + segment.byteSize, 0),
    note: 'Concatenate the segments in order to get one .zip file.',
  };
}

/**
 * Warn, at most once an hour per takedown, about evidence that has stayed unsettled (pending,
 * retrying, failed, or held on this server) for longer than the alert hours. Ids only.
 *
 * @returns How many warnings it logged.
 */
export async function warnOverdueTakedownEvidence(
  pool: Pool,
  options: Pick<TakedownWorkerOptions, 'now' | 'alertHours' | 'warn'>
): Promise<number> {
  const now = options.now ?? new Date();
  const overdue = await pool.query<{
    id: string;
    community_id: string;
    evidence_state: string;
  }>(
    `UPDATE community_takedowns SET evidence_alerted_at=$1
     WHERE evidence_state IN ('pending','retrying','failed','held_on_primary')
       AND created_at<=$1::timestamptz-make_interval(hours=>$2)
       AND (evidence_alerted_at IS NULL OR evidence_alerted_at<=$1::timestamptz-interval '1 hour')
     RETURNING id,community_id,evidence_state`,
    [now, options.alertHours]
  );
  const warn = options.warn ?? ((line: string) => console.warn(line));
  for (const row of overdue.rows)
    warn(
      JSON.stringify({
        event: 'community.takedown.evidence_overdue',
        takedownId: row.id,
        communityId: row.community_id,
        evidenceState: row.evidence_state,
      })
    );
  return overdue.rowCount ?? 0;
}

/**
 * One worker tick: copy what is due, a bounded number per tick, then warn about overdue
 * evidence. With no evidence store nothing is copied, but held evidence is still watched.
 */
export async function sweepTakedownEvidence(
  pool: Pool,
  blobStore: BlobStore,
  sink: EvidenceSink | null,
  options: TakedownWorkerOptions
): Promise<{ attempted: number; stored: number; warned: number }> {
  let attempted = 0;
  let stored = 0;
  if (sink) {
    for (; attempted < 10;) {
      const result = await copyDueTakedownEvidence(pool, blobStore, sink, options);
      if (!result.claimed) break;
      attempted++;
      if (result.stored) stored++;
    }
  }
  const warned = await warnOverdueTakedownEvidence(pool, options);
  return { attempted, stored, warned };
}
