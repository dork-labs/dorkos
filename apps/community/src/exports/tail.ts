import type { CommunityExportManifestV2 } from '@dorkos/shared/community-wire';
import { encodeEntriesIndex } from '../archive/zip-format.js';
import {
  writeZipTail,
  type ZipEntryInput,
  type ZipSegmentLayout,
} from '../archive/zip64-writer.js';
import { transaction } from '../data.js';
import {
  BlobStoreError,
  completeManagedBlobCommit,
  prepareManagedBlobCommit,
  type ManagedBlobReservation,
  type StoredBlob,
} from '../storage/index.js';
import { hasExportAuthority } from './authority.js';
import {
  collectionFiles,
  emptyTallies,
  type CollectionFile,
  type CollectionTallies,
} from './collections.js';
import { fileNumber, SegmentChangedError } from './data-segments.js';
import { JobFailedError, type ExportJob } from './job.js';
import { dropSegments } from './store.js';

/** Most bytes one collection file holds; the rest of the collection goes to the next file. */
const COLLECTION_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Write every collection file into collection segments after the last data segment, from one
 * `REPEATABLE READ` transaction, so names, roles and memberships are as of now and agree with
 * each other. Collection and tail segments from an earlier pass (or claim) are queued first.
 *
 * The transaction stays open while the collection segments upload. That holds one connection
 * per running export (the pool grows with `COMMUNITY_EXPORT_CONCURRENCY`, in main.ts) and one
 * snapshot; an exported snapshot (`pg_export_snapshot`) would not shorten either, since the
 * transaction that exports it must stay open for as long as others import it.
 */
export async function writeCollections(job: ExportJob): Promise<Collected> {
  await transaction(job.pool, async (client) => {
    await job.lockJob(client);
    await dropSegments(client, job.job.id, job.job.community_id, ['collection', 'tail']);
  });
  const dataCount = (await job.segments('data')).length;
  const reader = await job.pool.connect();
  try {
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const community = await reader.query<CommunityRow>(
      `SELECT c.id,c.name,c.description,c.admission_policy,c.lifecycle,c.lifecycle_version,
              c.settings_version,c.icon_blob_key,c.icon_content_type,
              m.byte_size::text AS icon_byte_size,m.checksum AS icon_checksum
       FROM communities c LEFT JOIN managed_blobs m
         ON m.blob_key=c.icon_blob_key AND m.community_id=c.id
       WHERE c.id=$1`,
      [job.job.community_id]
    );
    if (!community.rows[0]) throw new JobFailedError('EXPORT_ACCESS_ENDED');
    const tallies = emptyTallies();
    const files = collectionFiles(
      reader,
      {
        communityId: job.job.community_id,
        scope: job.job.scope,
        memberId: job.job.requester_member_id,
        channelIds: job.requester.channelIds,
      },
      tallies,
      Math.max(1, Math.min(COLLECTION_FILE_BYTES, Math.floor(job.target / 4)))
    );
    let segmentNo = dataCount + 1;
    let next = await files.next();
    while (!next.done) {
      await job.checkpoint();
      const counted = { bytes: 0, rows: 0 };
      const before = totalRows(tallies);
      const fileBytes = Math.max(1, Math.min(COLLECTION_FILE_BYTES, Math.floor(job.target / 4)));
      const target = job.target;
      const pending: { next: IteratorResult<CollectionFile> } = { next };
      const entries = (async function* (): AsyncGenerator<ZipEntryInput> {
        let added = 0;
        while (!pending.next.done) {
          if (added > 0 && counted.bytes + fileBytes > target) return;
          const file: CollectionFile = pending.next.value;
          yield { name: file.name, method: 'deflated', source: file.source };
          added++;
          pending.next = await files.next();
        }
      })();
      await job.storeSegment(countBytes(entries, counted), async (client, stored, index) => {
        counted.rows = totalRows(tallies) - before;
        await client.query(
          `INSERT INTO export_segments(export_id,segment_no,community_id,kind,blob_key,byte_size,
             entries_index,content_digest,entry_count,file_count)
           VALUES($1,$2,$3,'collection',$4,$5,$6,$7,$8,0)`,
          [
            job.job.id,
            segmentNo,
            job.job.community_id,
            stored.key,
            stored.byteSize,
            index,
            stored.sha256,
            counted.rows,
          ]
        );
      });
      await job.hooks.afterSegment?.({
        exportId: job.job.id,
        segmentNo,
        kind: 'collection',
      });
      next = pending.next;
      segmentNo++;
    }
    await reader.query('COMMIT');
    return { tallies, community: community.rows[0], nextSegmentNo: segmentNo };
  } catch (error) {
    await reader.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    reader.release();
  }
}

/**
 * Write the tail (the icon, `manifest.json` last, the central directory and the end records),
 * split into blobs that each start with a ZIP signature, and commit it with the job's move to
 * `ready` in one transaction. That transaction reads the content version `FOR SHARE`: a content
 * change that committed before it makes this return false (go round again); one that tries to
 * commit after it waits until the archive is ready. Returns true once ready.
 */
export async function writeTail(job: ExportJob, collected: Collected): Promise<boolean> {
  // Only sizes and counts here: each segment's central-directory rows are read when the tail
  // reaches it, so memory holds one segment's rows at a time however large the archive is.
  const all = await job.segments();
  const layouts: ZipSegmentLayout[] = all.map((segment) => ({
    byteSize: Number(segment.byte_size),
    entries: async function* () {
      yield* await job.entriesOf(segment.segment_no);
    },
  }));
  const data = all.filter((segment) => segment.kind === 'data');
  // Data segment n holds entries/n.ndjson, and attachments/n.ndjson exactly when it has files.
  const entryFiles = data.map((segment) => `entries/${fileNumber(segment.segment_no)}.ndjson`);
  const attachmentFiles = data
    .filter((segment) => segment.file_count > 0)
    .map((segment) => `attachments/${fileNumber(segment.segment_no)}.ndjson`);
  const { community, tallies } = collected;
  const icon =
    community.icon_blob_key && community.icon_byte_size && community.icon_checksum
      ? {
          key: community.icon_blob_key,
          contentType: community.icon_content_type ?? 'application/octet-stream',
          byteSize: Number(community.icon_byte_size),
          checksum: community.icon_checksum,
        }
      : null;
  const manifest: CommunityExportManifestV2 = {
    version: 2,
    scope: job.job.scope,
    exportId: job.job.id,
    requesterMemberId: job.job.requester_member_id,
    createdAt: job.job.created_at.toISOString(),
    completedAt: job.now().toISOString(),
    community: {
      id: community.id,
      name: community.name,
      description: community.description,
      admissionPolicy: community.admission_policy,
      lifecycle: community.lifecycle === 'active' ? 'active' : 'archived',
      lifecycleVersion: community.lifecycle_version,
      settingsVersion: community.settings_version,
      icon: icon
        ? {
            path: 'community/icon',
            contentType: icon.contentType,
            byteSize: icon.byteSize,
            checksum: icon.checksum,
          }
        : null,
    },
    files: {
      channels: tallies.channels.files,
      members: tallies.members.files,
      agents: tallies.agents.files,
      channelMembers: tallies.channelMembers.files,
      agentChannelMembers: tallies.agentChannelMembers.files,
      auditEvents: tallies.auditEvents.files,
      entries: entryFiles,
      attachments: attachmentFiles,
    },
    counts: {
      channels: tallies.channels.count,
      members: tallies.members.count,
      agents: tallies.agents.count,
      channelMembers: tallies.channelMembers.count,
      agentChannelMembers: tallies.agentChannelMembers.count,
      auditEvents: tallies.auditEvents.count,
      entries: data.reduce((sum, segment) => sum + segment.entry_count, 0),
      attachments: data.reduce((sum, segment) => sum + segment.file_count, 0),
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const { blobStore, hooks } = job;
  const exportId = job.job.id;
  const tailEntries = (async function* (): AsyncGenerator<ZipEntryInput> {
    if (icon) {
      let body;
      try {
        body = (await blobStore.get(icon.key)).body;
      } catch (error) {
        if (error instanceof BlobStoreError && error.code === 'BLOB_NOT_FOUND')
          throw new SegmentChangedError();
        throw error;
      }
      yield { name: 'community/icon', method: 'stored', size: icon.byteSize, source: body };
    }
    await hooks.duringTail?.(exportId);
    yield { name: 'manifest.json', method: 'deflated', source: manifestBytes };
  })();
  const tail = writeZipTail(
    { segments: layouts, entries: tailEntries },
    { modifiedAt: job.job.created_at }
  );
  const parts: { reservation: ManagedBlobReservation; stored?: StoredBlob }[] = [];
  let committed: boolean;
  try {
    for await (const part of tail.parts(job.target)) {
      await job.checkpoint();
      const piece: (typeof parts)[number] = { reservation: await job.reserve() };
      parts.push(piece);
      piece.stored = await job.put(piece.reservation, part);
    }
    const summary = tail.summary();
    await job.hooks.beforeTailCommit?.(job.job.id);
    committed = await transaction(job.pool, async (client) => {
      if (!(await hasExportAuthority(client, job.requester, true)))
        throw new JobFailedError('EXPORT_ACCESS_ENDED');
      const locked = await client.query<{ version: string }>(
        'SELECT version::text AS version FROM community_content_versions WHERE community_id=$1 FOR SHARE',
        [job.job.community_id]
      );
      await job.hooks.afterTailLock?.(job.job.id);
      if (locked.rows[0]?.version !== job.job.verified_content_version) return false;
      await job.lockJob(client);
      for (const [index, part] of parts.entries()) {
        const stored = part.stored!;
        await prepareManagedBlobCommit(client, part.reservation, stored);
        await client.query(
          `INSERT INTO export_segments(export_id,segment_no,community_id,kind,blob_key,byte_size,
             entries_index,content_digest,entry_count,file_count)
           VALUES($1,$2,$3,'tail',$4,$5,$6,$7,0,0)`,
          [
            job.job.id,
            collected.nextSegmentNo + index,
            job.job.community_id,
            stored.key,
            stored.byteSize,
            encodeEntriesIndex(index === 0 ? summary.entries : []),
            stored.sha256,
          ]
        );
        await completeManagedBlobCommit(client, part.reservation);
      }
      const now = job.now();
      await client.query(
        `UPDATE export_archives SET state='ready',ready_at=$2,
           expires_at=$2::timestamptz + $3 * interval '1 hour',lease_until=NULL,
           byte_size=(SELECT sum(byte_size) FROM export_segments WHERE export_id=$1)
         WHERE id=$1`,
        [job.job.id, now, job.settings.ttlHours]
      );
      await client.query(
        'INSERT INTO audit_events(community_id,actor_member_id,action,subject_id) VALUES($1,$2,$3,$4)',
        [job.job.community_id, job.job.requester_member_id, 'export.create', job.job.id]
      );
      return true;
    });
  } catch (error) {
    for (const part of parts) await job.discard(part.reservation, part.stored);
    if (error instanceof SegmentChangedError) return false;
    throw error;
  }
  if (!committed) for (const part of parts) await job.discard(part.reservation, part.stored);
  return committed;
}

/** The community row the manifest describes, with its icon. */
export interface CommunityRow {
  id: string;
  name: string;
  description: string | null;
  admission_policy: 'invite_only' | 'closed';
  lifecycle: string;
  lifecycle_version: number;
  settings_version: number;
  icon_blob_key: string | null;
  icon_content_type: string | null;
  icon_byte_size: string | null;
  icon_checksum: string | null;
}

/** What the collection phase hands the tail. */
export interface Collected {
  tallies: CollectionTallies;
  community: CommunityRow;
  nextSegmentNo: number;
}

function totalRows(tallies: CollectionTallies): number {
  return Object.values(tallies).reduce((sum, tally) => sum + tally.count, 0);
}

/**
 * Pass a segment's entries through while counting their uncompressed bytes. The collection
 * writer reads `counted.bytes` to decide when a segment is full; the compressed segment is never
 * larger than this count plus its headers.
 */
function countBytes(
  entries: AsyncIterable<ZipEntryInput>,
  counted: { bytes: number }
): AsyncIterable<ZipEntryInput> {
  return (async function* () {
    for await (const entry of entries) {
      const source = entry.source;
      yield {
        ...entry,
        source: (async function* () {
          for await (const chunk of source instanceof Uint8Array ? [source] : source) {
            counted.bytes += chunk.length;
            yield chunk;
          }
        })(),
      };
    }
  })();
}
