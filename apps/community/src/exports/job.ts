import type { Pool, PoolClient } from 'pg';
import {
  decodeEntriesIndex,
  encodeEntriesIndex,
  type ZipEntryRecord,
} from '../archive/zip-format.js';
import { writeZipSegment, type ZipEntryInput } from '../archive/zip64-writer.js';
import { transaction } from '../data.js';
import {
  completeManagedBlobCommit,
  discardManagedBlob,
  managedBlobWriteSignal,
  prepareManagedBlobCommit,
  reserveManagedBlob,
  type BlobStore,
  type ManagedBlobReservation,
  type StoredBlob,
} from '../storage/index.js';
import { hasExportAuthority, type ExportRequester } from './authority.js';
import type { EntryRange, EntryScope } from './data-segments.js';
import type { ExportRow } from './store.js';

/** How long a claimed job is its worker's; renewed after every segment and every minute. */
export const EXPORT_LEASE_MS = 5 * 60 * 1000;
/** Rebuild passes (rewrites after content changed) a job may make before it gives up. */
export const MAX_REBUILD_PASSES = 5;
/** Claims that ended in an unexpected error before the job fails as a storage failure. */
export const MAX_EXPORT_FAILURES = 5;
/** The `export_segment` put kind's ceiling; every segment stays below it. */
export const SEGMENT_CEILING = 1024 * 1024 * 1024;
/** Room kept under the ceiling for the estimate's error and the unit that crosses a target. */
const SEGMENT_HEADROOM = 64 * 1024 * 1024;

/** Settings the worker reads from `config.exports`. */
export interface ExportWorkerSettings {
  /** Target size of one segment blob. */
  segmentBytes: number;
  /** How long a ready archive stays downloadable. */
  ttlHours: number;
  /** How long one job may run from its first claim. */
  maxHours: number;
}

/** Test seams. Each runs outside any transaction unless it says otherwise. */
export interface ExportWorkerHooks {
  /** After a data or collection segment has committed. */
  afterSegment?: (event: {
    exportId: string;
    segmentNo: number;
    kind: 'data' | 'collection';
  }) => Promise<void>;
  /** Before one file's bytes are opened for a data segment. */
  beforeFile?: (event: { exportId: string; attachmentId: string }) => Promise<void>;
  /** After the collections are written, before the tail starts. */
  beforeTail?: (exportId: string) => Promise<void>;
  /** Inside the tail's byte stream (a tail blob is reserved and being written), before the manifest. */
  duringTail?: (exportId: string) => Promise<void>;
  /** After the tail is stored, before the transaction that commits it. */
  beforeTailCommit?: (exportId: string) => Promise<void>;
  /** Inside the final transaction, after the content version is read `FOR SHARE`. */
  afterTailLock?: (exportId: string) => Promise<void>;
}

/** What {@link runNextExport} needs. */
export interface ExportWorkerOptions {
  pool: Pool;
  blobStore: BlobStore;
  settings: ExportWorkerSettings;
  /** The clock leases, deadlines and lifetimes are judged by. Defaults to the wall clock. */
  now?: () => Date;
  hooks?: ExportWorkerHooks;
  /**
   * How long a job runs before it steps aside for a job of another community that is waiting.
   * Defaults to {@link EXPORT_SLICE_MS}.
   */
  sliceMs?: number;
}

/**
 * A job gives up its place after this long when another community's job is waiting, and
 * carries on from its last segment when its turn comes round again, so one long export cannot
 * hold every export on a host back.
 */
export const EXPORT_SLICE_MS = 10 * 60 * 1000;

/** The job ended while this worker held it: cancelled, or claimed by another worker. */
export class JobLostError extends Error {
  constructor() {
    super('The export job is no longer held by this worker');
    this.name = 'JobLostError';
  }
}

/** The job cannot finish; it fails with this code and its segments are queued. */
export class JobFailedError extends Error {
  constructor(
    readonly code: 'EXPORT_TIMED_OUT' | 'EXPORT_ACCESS_ENDED' | 'EXPORT_CONTENT_CHANGING'
  ) {
    super(code);
    this.name = 'JobFailedError';
  }
}

/** One `export_segments` row as the worker reads it. */
export interface SegmentRow {
  segment_no: number;
  kind: 'data' | 'collection' | 'tail';
  blob_key: string;
  byte_size: string;
  first_channel_id: string | null;
  first_seq: string | null;
  last_channel_id: string | null;
  last_seq: string | null;
  content_digest: string;
  entry_count: number;
  file_count: number;
}

/** The message range a data segment covers. */
export function rangeOf(row: SegmentRow): EntryRange {
  return {
    first: { channelId: row.first_channel_id!, seq: Number(row.first_seq) },
    last: { channelId: row.last_channel_id!, seq: Number(row.last_seq) },
  };
}

/**
 * One claimed job's state and the steps every phase shares: the lease and its fence, the
 * checkpoint before each segment, rebuild passes, and storing a segment blob with its rows.
 */
export class ExportJob {
  readonly pool: Pool;
  readonly blobStore: BlobStore;
  readonly settings: ExportWorkerSettings;
  readonly hooks: ExportWorkerHooks;
  /** The claim's attempt number; every write checks it, so a replaced worker writes nothing. */
  readonly fence: number;
  /** Who asked, and what they may still read; set when the job starts or resumes. */
  requester!: ExportRequester;
  /** The watermarked messages this export covers. */
  scope!: EntryScope;

  constructor(
    readonly options: ExportWorkerOptions,
    public job: ExportRow,
    readonly now: () => Date
  ) {
    this.pool = options.pool;
    this.blobStore = options.blobStore;
    this.settings = options.settings;
    this.hooks = options.hooks ?? {};
    this.fence = job.attempts;
  }

  /** Target size of one segment, kept under the blob ceiling. */
  get target(): number {
    return Math.min(this.settings.segmentBytes, SEGMENT_CEILING - SEGMENT_HEADROOM);
  }

  /** Extend the lease; the job is lost when it is no longer building under this claim. */
  async renewLease(client: Pick<Pool | PoolClient, 'query'> = this.pool): Promise<void> {
    const renewed = await client.query(
      `UPDATE export_archives SET lease_until=$3::timestamptz + $4 * interval '1 millisecond'
       WHERE id=$1 AND state='building' AND attempts=$2`,
      [this.job.id, this.fence, this.now(), EXPORT_LEASE_MS]
    );
    if (renewed.rowCount !== 1) throw new JobLostError();
  }

  /** Lock the job row for this claim inside a commit transaction. */
  async lockJob(client: PoolClient): Promise<void> {
    const locked = await client.query(
      `SELECT 1 FROM export_archives WHERE id=$1 AND state='building' AND attempts=$2 FOR UPDATE`,
      [this.job.id, this.fence]
    );
    if (!locked.rowCount) throw new JobLostError();
  }

  /**
   * Before every segment: the job is still ours (lease renewed), within its deadline, and its
   * requester still has the authority it had when they asked.
   */
  async checkpoint(): Promise<void> {
    await this.renewLease();
    if (this.job.deadline_at && this.now() >= this.job.deadline_at)
      throw new JobFailedError('EXPORT_TIMED_OUT');
    if (!(await hasExportAuthority(this.pool, this.requester)))
      throw new JobFailedError('EXPORT_ACCESS_ENDED');
  }

  /** Count one rebuild pass, or fail the job when it has made them all. */
  async countPass(): Promise<void> {
    const counted = await this.pool.query<{ rebuild_passes: number }>(
      `UPDATE export_archives SET rebuild_passes=rebuild_passes+1
       WHERE id=$1 AND state='building' AND attempts=$2 AND rebuild_passes<$3
       RETURNING rebuild_passes`,
      [this.job.id, this.fence, MAX_REBUILD_PASSES]
    );
    if (counted.rows[0]) {
      this.job.rebuild_passes = counted.rows[0].rebuild_passes;
      return;
    }
    await this.renewLease();
    throw new JobFailedError('EXPORT_CONTENT_CHANGING');
  }

  /** This export's committed segments (without their central-directory rows), in order. */
  async segments(kind?: SegmentRow['kind']): Promise<SegmentRow[]> {
    const result = await this.pool.query<SegmentRow>(
      `SELECT segment_no,kind,blob_key,byte_size::text,first_channel_id,first_seq::text,
              last_channel_id,last_seq::text,content_digest,entry_count,file_count
       FROM export_segments WHERE export_id=$1 AND community_id=$2 AND ($3::text IS NULL OR kind=$3)
       ORDER BY segment_no`,
      [this.job.id, this.job.community_id, kind ?? null]
    );
    return result.rows;
  }

  /** One segment's central-directory rows, read when the tail reaches that segment. */
  async entriesOf(segmentNo: number): Promise<ZipEntryRecord[]> {
    const result = await this.pool.query<{ entries_index: Buffer }>(
      'SELECT entries_index FROM export_segments WHERE export_id=$1 AND community_id=$2 AND segment_no=$3',
      [this.job.id, this.job.community_id, segmentNo]
    );
    if (!result.rows[0]) throw new JobLostError();
    return decodeEntriesIndex(result.rows[0].entries_index);
  }

  /**
   * Reserve a blob, write one segment's entries into it, and commit the blob with the caller's
   * rows in one transaction that also renews the lease. An uncommitted blob is discarded.
   */
  async storeSegment(
    entries: AsyncIterable<ZipEntryInput>,
    commit: (client: PoolClient, stored: StoredBlob, entriesIndex: Buffer) => Promise<void>
  ): Promise<void> {
    const reservation = await this.reserve();
    let stored: StoredBlob | undefined;
    try {
      const writer = writeZipSegment(entries, { modifiedAt: this.job.created_at });
      stored = await this.put(reservation, writer.bytes);
      const summary = writer.summary();
      const index = encodeEntriesIndex(summary.entries);
      const blob = stored;
      await transaction(this.pool, async (client) => {
        await prepareManagedBlobCommit(client, reservation, blob);
        await this.lockJob(client);
        await commit(client, blob, index);
        await completeManagedBlobCommit(client, reservation);
        await this.renewLease(client);
      });
    } catch (error) {
      await this.discard(reservation, stored);
      throw error;
    }
  }

  reserve(): Promise<ManagedBlobReservation> {
    return transaction(this.pool, (client) =>
      reserveManagedBlob(client, this.job.community_id, 'export', {
        allowArchived: this.job.scope === 'owner',
      })
    );
  }

  put(reservation: ManagedBlobReservation, source: AsyncIterable<Uint8Array>) {
    return this.blobStore.put({
      key: reservation.key,
      source,
      displayName: 'community-export.zip',
      maxBytes: SEGMENT_CEILING,
      kind: 'export_segment',
      signal: managedBlobWriteSignal(),
    });
  }

  /** Discard a blob that did not commit; a failure to queue it is logged, not thrown. */
  async discard(reservation: ManagedBlobReservation, stored?: StoredBlob): Promise<void> {
    await discardManagedBlob(this.pool, this.blobStore, reservation, stored).catch(
      (error: unknown) => {
        console.error(
          'Community export blob cleanup could not be queued',
          error instanceof Error ? error.name : 'unknown'
        );
      }
    );
  }
}
