import { transaction } from '../data.js';
import { BlobStoreError, queueCommittedBlobDeletion } from '../storage/index.js';
import { hasExportAuthority, READABLE_CHANNEL_SQL } from './authority.js';
import {
  countScope,
  dataSegmentEntries,
  digestDataRange,
  entryScope,
  planDataSegment,
  SegmentChangedError,
  START_CURSOR,
  type DataSegmentTally,
  type EntryRange,
} from './data-segments.js';
import {
  EXPORT_LEASE_MS,
  ExportJob,
  JobFailedError,
  JobLostError,
  EXPORT_SLICE_MS,
  MAX_EXPORT_FAILURES,
  rangeOf,
  type ExportWorkerOptions,
  type SegmentRow,
} from './job.js';
import { endExportJob, EXPORT_COLUMNS, type ExportRow } from './store.js';
import { writeCollections, writeTail } from './tail.js';

export {
  EXPORT_LEASE_MS,
  EXPORT_SLICE_MS,
  MAX_EXPORT_FAILURES,
  MAX_REBUILD_PASSES,
  type ExportWorkerHooks,
  type ExportWorkerOptions,
  type ExportWorkerSettings,
} from './job.js';

const HEARTBEAT_MS = 60 * 1000;

function logUnavailable(exportId: string, cause: unknown): void {
  console.error('Community export state could not be recorded', {
    exportId,
    error: cause instanceof Error ? cause.name : 'unknown',
  });
}

/**
 * Claim one due job: queued, or building with an expired lease (its worker died). The claim
 * moves it to `building`, takes a lease, and starts its deadline on the first claim.
 */
async function claimExport(options: ExportWorkerOptions, now: Date): Promise<ExportRow | null> {
  // The least recently served job first, so jobs take turns; and one job per community at a
  // time, so a community's second export waits for its first instead of taking another slot.
  const claimed = await options.pool.query<ExportRow>(
    `UPDATE export_archives
     SET state='building',attempts=attempts+1,claimed_at=$1,
         lease_until=$1::timestamptz + $2 * interval '1 millisecond'
     WHERE id=(
       SELECT e.id FROM export_archives e
       WHERE e.state IN ('queued','building') AND e.next_attempt_at<=$1
         AND (e.lease_until IS NULL OR e.lease_until<$1)
         AND NOT EXISTS (
           SELECT 1 FROM export_archives other
           WHERE other.community_id=e.community_id AND other.id<>e.id
             AND other.state='building' AND other.lease_until>=$1)
       ORDER BY e.claimed_at NULLS FIRST,e.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING ${EXPORT_COLUMNS}`,
    [now, EXPORT_LEASE_MS]
  );
  return claimed.rows[0] ?? null;
}

/**
 * Claim one due export job and run it until it is ready, fails, is cancelled, or meets an
 * unexpected error (it is then retried later from its last committed segment). Returns the job's
 * id, or null when none was due.
 */
export async function runNextExport(options: ExportWorkerOptions): Promise<string | null> {
  const now = options.now ?? (() => new Date());
  const job = await claimExport(options, now());
  if (!job) return null;
  await new ExportRun(options, job, now).execute();
  return job.id;
}

/**
 * Run export jobs in the background: every `pollMs`, claim due jobs until `concurrency` are
 * running on this replica. Returns the timer, for the shutdown path to clear.
 */
export function startExportWorker(
  options: ExportWorkerOptions & { concurrency: number; pollMs?: number }
): ReturnType<typeof setInterval> {
  const now = options.now ?? (() => new Date());
  let running = 0;
  let claiming = false;
  const timer = setInterval(() => {
    if (claiming) return;
    claiming = true;
    void (async () => {
      while (running < options.concurrency) {
        const job = await claimExport(options, now());
        if (!job) return;
        running++;
        void new ExportRun(options, job, now)
          .execute()
          .catch((error: unknown) => {
            console.error(
              'Community export worker unavailable',
              error instanceof Error ? error.name : 'unknown'
            );
          })
          .finally(() => {
            running--;
          });
      }
    })()
      .catch((error: unknown) => {
        console.error(
          'Community export worker unavailable',
          error instanceof Error ? error.name : 'unknown'
        );
      })
      .finally(() => {
        claiming = false;
      });
  }, options.pollMs ?? 2_000);
  timer.unref();
  return timer;
}

/** One claimed job, run by this worker until it ends, is lost, or steps aside. */
class ExportRun extends ExportJob {
  /** Renews the lease every minute while the job runs. */
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  /**
   * Run the job. Never rejects: every outcome (ready, failed, lost, stepped aside, retried
   * later) is recorded, and a database that is gone at that moment is logged, not thrown, so a
   * worker stopping with the process leaves only a lease to expire.
   */
  async execute(): Promise<void> {
    this.heartbeat = setInterval(() => {
      void this.renewLease().catch(() => undefined);
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
    try {
      await this.start();
      if ((await this.writeDataSegments()) === 'yielded') return;
      await this.finish();
    } catch (error) {
      if (error instanceof JobLostError) return;
      if (error instanceof JobFailedError) {
        await transaction(this.pool, (client) =>
          endExportJob(
            client,
            this.job.id,
            { state: 'failed', code: error.code },
            this.now(),
            this.fence
          )
        ).catch((cause: unknown) => logUnavailable(this.job.id, cause));
        return;
      }
      await this.retryLater(error).catch((cause: unknown) => logUnavailable(this.job.id, cause));
    } finally {
      clearInterval(this.heartbeat);
    }
  }

  /**
   * After a segment: past its time slice with another community's job waiting, the job gives
   * up its lease (not counted as a failure) so the other can run, and resumes later.
   */
  private async stepAside(): Promise<boolean> {
    const slice = this.options.sliceMs ?? EXPORT_SLICE_MS;
    if (this.now().getTime() - this.claimedAt < slice) return false;
    // Only a job that could be claimed now counts: due, not leased, and not in a community
    // whose other export is already running.
    const waiting = await this.pool.query(
      `SELECT 1 FROM export_archives e
       WHERE e.state IN ('queued','building') AND e.community_id<>$1 AND e.next_attempt_at<=$2
         AND (e.lease_until IS NULL OR e.lease_until<$2)
         AND NOT EXISTS (
           SELECT 1 FROM export_archives other
           WHERE other.community_id=e.community_id AND other.id<>e.id
             AND other.state='building' AND other.lease_until>=$2)
       LIMIT 1`,
      [this.job.community_id, this.now()]
    );
    if (!waiting.rowCount) return false;
    // Stop renewing first, or a renewal in flight could take the lease back after its release.
    clearInterval(this.heartbeat);
    const released = await this.pool.query(
      `UPDATE export_archives SET lease_until=NULL,run_ms=$3
       WHERE id=$1 AND state='building' AND attempts=$2`,
      [this.job.id, this.fence, this.runMs()]
    );
    if (released.rowCount !== 1) throw new JobLostError();
    return true;
  }

  /**
   * An unexpected error: count a failure and retry later with backoff, or fail the job as a
   * storage failure after {@link MAX_EXPORT_FAILURES}.
   */
  private async retryLater(error: unknown): Promise<void> {
    console.error('Community export attempt failed', {
      exportId: this.job.id,
      error:
        error instanceof BlobStoreError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'unknown',
    });
    // Failures are counted apart from claims, so a job that steps aside or outlives a restart
    // is not failed for it.
    const counted = await this.pool.query<{ failures: number }>(
      `UPDATE export_archives SET failures=failures+1
       WHERE id=$1 AND state='building' AND attempts=$2 RETURNING failures`,
      [this.job.id, this.fence]
    );
    const failures = counted.rows[0]?.failures;
    if (failures === undefined) return;
    if (failures >= MAX_EXPORT_FAILURES) {
      await transaction(this.pool, (client) =>
        endExportJob(
          client,
          this.job.id,
          { state: 'failed', code: 'EXPORT_STORAGE_UNAVAILABLE' },
          this.now(),
          this.fence
        )
      );
      return;
    }
    // One minute, doubling per failure, at most half an hour. The lease is released so the
    // retry can be claimed as soon as it is due.
    const delay = Math.min(60_000 * 2 ** (failures - 1), 30 * 60_000);
    await this.pool.query(
      `UPDATE export_archives SET lease_until=NULL,run_ms=$5,
         next_attempt_at=$3::timestamptz + $4 * interval '1 millisecond'
       WHERE id=$1 AND state='building' AND attempts=$2`,
      [this.job.id, this.fence, this.now(), delay, this.runMs()]
    );
  }

  /**
   * On the first claim, record in one short transaction what the export covers: the channels,
   * `max(seq)` in each (later messages are not exported), the newest redaction row, the content
   * version, and the total the progress bar counts toward. Holding the content version `FOR
   * SHARE` makes all of that one consistent point: no content change can commit during it.
   */
  private async start(): Promise<void> {
    const channelIds =
      this.job.scope === 'personal'
        ? (
            await this.pool.query<{ channel_id: string }>(
              `SELECT channel_id FROM export_archive_channels
               WHERE export_archive_id=$1 AND community_id=$2 ORDER BY position`,
              [this.job.id, this.job.community_id]
            )
          ).rows.map((row) => row.channel_id)
        : [];
    this.requester = {
      communityId: this.job.community_id,
      memberId: this.job.requester_member_id,
      scope: this.job.scope,
      channelIds,
    };
    if (this.job.watermark) {
      this.scope = entryScope(
        this.job.community_id,
        this.job.scope === 'personal' ? this.job.requester_member_id : null,
        this.job.watermark
      );
      return;
    }
    await this.checkpoint();
    const started = await transaction(this.pool, async (client) => {
      await this.lockJob(client);
      if (!(await hasExportAuthority(client, this.requester, true)))
        throw new JobFailedError('EXPORT_ACCESS_ENDED');
      const version = await client.query<{ version: string }>(
        'SELECT version::text AS version FROM community_content_versions WHERE community_id=$1 FOR SHARE',
        [this.job.community_id]
      );
      const channels =
        this.job.scope === 'owner'
          ? await client.query<{ id: string }>(
              'SELECT id FROM channels WHERE community_id=$1 ORDER BY id',
              [this.job.community_id]
            )
          : await client.query<{ id: string }>(
              `SELECT c.id FROM channels c WHERE c.community_id=$2 AND ${READABLE_CHANNEL_SQL}
               ORDER BY c.id`,
              [this.job.requester_member_id, this.job.community_id]
            );
      const ids = channels.rows.map((row) => row.id);
      const marks = await client.query<{ channel_id: string; seq: string }>(
        `SELECT channel_id,max(seq)::text AS seq FROM entries
         WHERE community_id=$1 AND channel_id=ANY($2::uuid[]) GROUP BY channel_id`,
        [this.job.community_id, ids]
      );
      const watermark = Object.fromEntries(
        marks.rows.map((row) => [row.channel_id, Number(row.seq)])
      );
      const redaction = await client.query<{ id: string }>(
        'SELECT COALESCE(max(id),0)::text AS id FROM entry_redactions WHERE community_id=$1',
        [this.job.community_id]
      );
      const scope = entryScope(
        this.job.community_id,
        this.job.scope === 'personal' ? this.job.requester_member_id : null,
        watermark
      );
      const total = await countScope(client, scope);
      if (this.job.scope === 'personal') {
        await client.query(
          `INSERT INTO export_archive_channels(export_archive_id,position,community_id,channel_id)
           SELECT $1,selected.position,$2,selected.channel_id
           FROM unnest($3::uuid[]) WITH ORDINALITY AS selected(channel_id,position)`,
          [this.job.id, this.job.community_id, ids]
        );
      }
      await client.query(
        `UPDATE export_archives SET watermark=$2,last_checked_redaction_id=$3,
           verified_content_version=$4,progress_total=$5
         WHERE id=$1`,
        [
          this.job.id,
          JSON.stringify(watermark),
          redaction.rows[0].id,
          version.rows[0].version,
          total,
        ]
      );
      return { scope, ids, redactionId: redaction.rows[0].id, version: version.rows[0].version };
    });
    this.scope = started.scope;
    if (this.job.scope === 'personal') this.requester.channelIds = started.ids;
    this.job.last_checked_redaction_id = started.redactionId;
    this.job.verified_content_version = started.version;
  }

  /**
   * Write data segments from the last committed one until every exported message is written,
   * stepping aside between segments when the job's time slice is over and another waits.
   */
  private async writeDataSegments(): Promise<'done' | 'yielded'> {
    if (this.job.data_complete) return 'done';
    const written = await this.segments('data');
    let cursor = written.length ? rangeOf(written[written.length - 1]).last : START_CURSOR;
    let segmentNo = written.length + 1;
    while (true) {
      await this.checkpoint();
      const range = await planDataSegment(this.pool, this.scope, cursor, this.target);
      if (!range) break;
      await this.writeDataSegment(segmentNo, range, false);
      cursor = range.last;
      segmentNo++;
      if (await this.stepAside()) return 'yielded';
    }
    await this.pool.query(
      `UPDATE export_archives SET data_complete=true WHERE id=$1 AND state='building' AND attempts=$2`,
      [this.job.id, this.fence]
    );
    this.job.data_complete = true;
    return 'done';
  }

  /**
   * Write (or rewrite) one data segment from the database as it is now. A file that vanished
   * while the segment was written discards it and writes it again, counted as a rebuild pass.
   */
  private async writeDataSegment(
    segmentNo: number,
    range: EntryRange,
    replacing: boolean
  ): Promise<void> {
    while (true) {
      // Redaction rows up to this one committed before the messages are read below, so the
      // segment already reflects them (content changes take the version lock before their row).
      const read = await this.pool.query<{ id: string }>(
        'SELECT COALESCE(max(id),0)::text AS id FROM entry_redactions WHERE community_id=$1',
        [this.job.community_id]
      );
      const tally: DataSegmentTally = { entryCount: 0, fileCount: 0, digest: null };
      const entries = dataSegmentEntries(
        {
          db: this.pool,
          blobStore: this.blobStore,
          scope: this.scope,
          range,
          segmentNo,
          beforeFile: (attachmentId) =>
            this.hooks.beforeFile?.({ exportId: this.job.id, attachmentId }) ?? Promise.resolve(),
        },
        tally
      );
      try {
        await this.storeSegment(entries, async (client, stored, index) => {
          const values = [
            this.job.id,
            segmentNo,
            this.job.community_id,
            stored.key,
            stored.byteSize,
            range.first.channelId,
            range.first.seq,
            range.last.channelId,
            range.last.seq,
            read.rows[0].id,
            index,
            tally.digest,
            tally.entryCount,
            tally.fileCount,
          ];
          if (replacing) {
            const old = await client.query<{ blob_key: string }>(
              `SELECT blob_key FROM export_segments WHERE export_id=$1 AND segment_no=$2 FOR UPDATE`,
              [this.job.id, segmentNo]
            );
            await client.query(
              `UPDATE export_segments SET blob_key=$4,byte_size=$5,first_channel_id=$6,first_seq=$7,
                 last_channel_id=$8,last_seq=$9,read_redaction_id=$10,entries_index=$11,
                 content_digest=$12,entry_count=$13,file_count=$14,created_at=now()
               WHERE export_id=$1 AND segment_no=$2 AND community_id=$3 AND kind='data'`,
              values
            );
            await queueCommittedBlobDeletion(client, this.job.community_id, old.rows[0].blob_key);
          } else {
            await client.query(
              `INSERT INTO export_segments(export_id,segment_no,community_id,kind,blob_key,byte_size,
                 first_channel_id,first_seq,last_channel_id,last_seq,read_redaction_id,entries_index,
                 content_digest,entry_count,file_count)
               VALUES($1,$2,$3,'data',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
              values
            );
          }
          await client.query(
            `UPDATE export_archives SET progress_done=(
               SELECT COALESCE(sum(entry_count+file_count),0) FROM export_segments
               WHERE export_id=$1 AND kind='data')
             WHERE id=$1`,
            [this.job.id]
          );
        });
      } catch (error) {
        if (!(error instanceof SegmentChangedError)) throw error;
        await this.countPass();
        await this.checkpoint();
        continue;
      }
      await this.hooks.afterSegment?.({ exportId: this.job.id, segmentNo, kind: 'data' });
      return;
    }
  }

  /**
   * Bring the data segments up to date with the database before the tail is written. While the
   * content version has moved since the last check: rewrite each segment a newer redaction row
   * points into (rows above the watermark, or for another author's message in a personal export,
   * change nothing exported); if the version moved with no redaction row at all, compare every
   * segment's digest with the database and rewrite those that differ. Each round that rewrites
   * counts as a rebuild pass.
   */
  private async reconcile(): Promise<void> {
    while (true) {
      const current = await this.pool.query<{ version: string }>(
        'SELECT version::text AS version FROM community_content_versions WHERE community_id=$1',
        [this.job.community_id]
      );
      const version = current.rows[0]?.version;
      if (version === undefined) throw new JobFailedError('EXPORT_ACCESS_ENDED');
      if (version === this.job.verified_content_version) return;
      const checked = this.job.last_checked_redaction_id ?? '0';
      const newest = await this.pool.query<{ id: string | null }>(
        'SELECT max(id)::text AS id FROM entry_redactions WHERE community_id=$1 AND id>$2',
        [this.job.community_id, checked]
      );
      const through = newest.rows[0].id;
      const data = await this.segments('data');
      let stale: SegmentRow[];
      if (through !== null) {
        const hit = await this.pool.query<{ segment_no: number }>(
          `SELECT DISTINCT s.segment_no FROM entry_redactions r
           JOIN entries e ON e.id=r.entry_id AND e.community_id=r.community_id
           JOIN unnest($4::uuid[],$5::bigint[]) AS w(channel_id,seq)
             ON w.channel_id=e.channel_id AND e.seq<=w.seq
           JOIN export_segments s ON s.export_id=$6 AND s.community_id=r.community_id
             AND s.kind='data' AND r.id>s.read_redaction_id
             AND (e.channel_id,e.seq) BETWEEN (s.first_channel_id,s.first_seq)
                                          AND (s.last_channel_id,s.last_seq)
           WHERE r.community_id=$1 AND r.id>$2 AND r.id<=$3
             AND ($7::uuid IS NULL OR e.author_member_id=$7 OR e.author_agent_id IN (
               SELECT id FROM agents WHERE owner_member_id=$7 AND community_id=$1))`,
          [
            this.job.community_id,
            checked,
            through,
            this.scope.channelIds,
            this.scope.seqs,
            this.job.id,
            this.scope.authorMemberId,
          ]
        );
        const numbers = new Set(hit.rows.map((row) => row.segment_no));
        stale = data.filter((segment) => numbers.has(segment.segment_no));
      } else {
        // The version moved with no redaction row: a change that broke the rule, or one of the
        // allowed kinds (an export deletion, a member or agent change) that the collections read
        // fresh anyway. Only a segment whose digest no longer matches the database is rewritten.
        stale = [];
        for (const segment of data) {
          const digest = await digestDataRange(this.pool, this.scope, rangeOf(segment));
          if (digest !== segment.content_digest) stale.push(segment);
        }
      }
      if (stale.length) {
        await this.countPass();
        for (const segment of stale) {
          await this.checkpoint();
          await this.writeDataSegment(segment.segment_no, rangeOf(segment), true);
        }
      }
      const recorded = await this.pool.query(
        `UPDATE export_archives SET verified_content_version=$3,
           last_checked_redaction_id=GREATEST(last_checked_redaction_id,$4::bigint)
         WHERE id=$1 AND state='building' AND attempts=$2`,
        [this.job.id, this.fence, version, through ?? checked]
      );
      if (recorded.rowCount !== 1) throw new JobLostError();
      this.job.verified_content_version = version;
      this.job.last_checked_redaction_id = through ?? checked;
    }
  }

  /**
   * Check, write the collections and the tail, and commit the tail only if the content version
   * is still the one the data segments were checked against. Otherwise go round again (a pass).
   */
  private async finish(): Promise<void> {
    while (true) {
      await this.checkpoint();
      await this.reconcile();
      await this.checkpoint();
      const collected = await writeCollections(this);
      await this.checkpoint();
      await this.hooks.beforeTail?.(this.job.id);
      if (await writeTail(this, collected)) return;
      await this.countPass();
    }
  }
}
