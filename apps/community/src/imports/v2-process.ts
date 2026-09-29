import type { Pool, PoolClient } from 'pg';
import type { RangeReader } from '../archive/segmented-source.js';
import { readLimits } from '../host/limits.js';
import type { BlobStore } from '../storage/index.js';
import { uuidv5 } from './derived-id.js';
import {
  fenced,
  finishRestore,
  receivedAt,
  renewLease,
  storeRestoredFile,
  type ClaimedImport,
} from './job.js';
import { ImportFailure, type ImportLimits } from './manifest.js';
import type { ImportWorkerHooks } from './process.js';
import type { ImportReport, ImportRow } from './store.js';
import {
  collectionLines,
  FileCursor,
  ICON_SOURCE_ID,
  openExportV2,
  verifiedEntry,
  type OpenedExportV2,
  type V2Collection,
} from './v2-archive.js';
import { maxLineBytes, V2RowRules, V2Tally, type V2Row } from './v2-rows.js';
import { STEPS, weight, type RestoreScope } from './v2-writers.js';

/** The most rows one restore batch inserts, counting a message's mentions. */
export const RESTORE_BATCH_ROWS = 1_000;
/** How often a long check renews its lease while it streams rows. */
const RENEW_EVERY_MS = 30_000;

function invalid(condition: boolean): void {
  if (condition) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
}

/** What reading a version 2 export's rows needs. */
interface V2Reading {
  opened: OpenedExportV2;
  rules: V2RowRules;
  maxLine: number;
}

/** Everything one restore pass over a version 2 export needs. */
interface V2Context extends V2Reading {
  pool: Pool;
  blobStore: BlobStore;
  job: ClaimedImport;
}

/**
 * The attachment rows in manifest order, `size` at a time. Each batch closes its read of the
 * attachments file before it is handed out, so no storage read stays open while the caller
 * hashes or stores that batch's files; the next batch reopens the file where this one ended.
 */
async function* attachmentBatches(
  context: V2Reading,
  size = RESTORE_BATCH_ROWS
): AsyncGenerator<V2Row['attachments'][]> {
  let from = { file: 0, line: 0 };
  while (true) {
    const batch: V2Row['attachments'][] = [];
    let reached = from;
    for await (const line of collectionLines(
      context.opened,
      'attachments',
      context.maxLine,
      from
    )) {
      batch.push(context.rules.parse('attachments', line.bytes));
      reached = { file: line.file, line: line.line };
      if (batch.length >= size) break;
    }
    if (!batch.length) return;
    yield batch;
    if (batch.length < size) return;
    from = reached;
  }
}

/**
 * Each attachment row with its `files/` entry: the n-th row names the n-th file in directory
 * order, and the archive holds no file the rows do not name.
 */
async function* attachmentsWithFiles(context: V2Reading) {
  const cursor = new FileCursor(context.opened.archive);
  for await (const batch of attachmentBatches(context)) {
    const pairs = [];
    for (const row of batch) {
      const entry = await cursor.take();
      invalid(!entry || entry.name !== row.archivePath);
      pairs.push({ row, entry: entry! });
    }
    yield pairs;
  }
  invalid((await cursor.take()) !== null);
}

/** What a check of a version 2 export found: its row counts and the bytes it will store. */
export interface V2Check {
  tally: V2Tally;
  /** Every file and the icon: what counts against the storage limit. */
  countedBytes: number;
}

/**
 * Check an opened version 2 owner export end to end without storing anything, streaming every
 * file: every NDJSON line in manifest order parsed with its strict row schema and the rules
 * each row keeps on its own (see {@link V2RowRules}); each collection's row count against the
 * manifest; exactly one active owner, the one who made the export; messages in channel then
 * sequence order; each attachment row paired with the next `files/` entry, whose name, length
 * and SHA-256 must match it, and no file left over; and the icon against the manifest. Checks
 * between rows run during the restore, batch by batch. `keepLease` runs as the check goes.
 */
export async function checkExportV2(
  opened: OpenedExportV2,
  limits: ImportLimits,
  receivedAt: Date,
  keepLease: () => Promise<void> = async () => undefined
): Promise<V2Check> {
  const { manifest } = opened;
  const reading: V2Reading = {
    opened,
    rules: new V2RowRules(manifest, limits, receivedAt),
    maxLine: maxLineBytes(limits),
  };
  const tally = new V2Tally(manifest);
  const rowCollections: V2Collection[] = [
    'channels',
    'members',
    'agents',
    'channelMembers',
    'agentChannelMembers',
    'auditEvents',
    'entries',
  ];
  for (const key of rowCollections) {
    for await (const line of collectionLines(opened, key, reading.maxLine)) {
      tally.add(key, reading.rules.parse(key, line.bytes));
      await keepLease();
    }
  }
  for await (const pairs of attachmentsWithFiles(reading)) {
    for (const { row: attachment, entry } of pairs) {
      tally.add('attachments', attachment);
      for await (const _chunk of verifiedEntry(opened.archive, entry, attachment)) {
        // Only the length and digest matter here; the bytes are stored during restore.
      }
      await keepLease();
    }
  }
  const icon = manifest.community.icon;
  if (icon && opened.icon) {
    for await (const _chunk of verifiedEntry(opened.archive, opened.icon, icon)) {
      // As above.
    }
  }
  tally.finish();
  return { tally, countedBytes: tally.attachmentBytes + (icon?.byteSize ?? 0) };
}

/**
 * Check an uploaded version 2 owner export (see {@link checkExportV2}) and its total against
 * the community's storage limit, renewing the job's lease as it goes, and report on it.
 */
export async function validateV2(
  pool: Pool,
  job: ClaimedImport,
  row: ImportRow,
  source: RangeReader,
  limits: ImportLimits
): Promise<ImportReport> {
  const opened = await openExportV2(source, limits);
  let renewedAt = Date.now();
  const { tally, countedBytes } = await checkExportV2(opened, limits, receivedAt(row), async () => {
    if (Date.now() - renewedAt < RENEW_EVERY_MS) return;
    await renewLease(pool, job);
    renewedAt = Date.now();
  });
  const { maxStorageBytes } = await readLimits(pool, row.community_id!);
  const fitsStorageLimit = maxStorageBytes === null || countedBytes <= maxStorageBytes;
  if (!fitsStorageLimit) throw new ImportFailure('STORAGE_LIMIT_REACHED');
  return {
    manifestVersion: 2,
    sourceLifecycle: opened.manifest.community.lifecycle,
    channels: tally.counts.channels,
    entries: tally.counts.entries,
    attachments: tally.counts.attachments,
    historicalMembers: tally.counts.members,
    historicalAgents: tally.counts.agents,
    auditEvents: tally.counts.auditEvents,
    attachmentBytes: tally.attachmentBytes,
    countedBytes,
    fitsStorageLimit,
    shortened: tally.shortened,
  };
}

/** Where a version 2 restore stands: step index, file within it, lines of that file done. */
interface Progress {
  step: number;
  file: number;
  line: number;
}

/**
 * Store every file (each attachment, then the icon) the way version 1 does, skipping the ones
 * a crashed worker already recorded. Each file is found by walking the directory alongside the
 * attachment rows, verified again, and staged locally before storage.
 */
async function restoreFiles(context: V2Context, hooks: ImportWorkerHooks): Promise<void> {
  const { pool, blobStore, job, opened } = context;
  let stored = 0;
  for await (const pairs of attachmentsWithFiles(context)) {
    const recorded = await pool.query<{ source_attachment_id: string }>(
      `SELECT source_attachment_id FROM community_import_files
       WHERE import_id=$1 AND source_attachment_id=ANY($2::uuid[])`,
      [job.id, pairs.map((pair) => pair.row.id)]
    );
    const done = new Set(recorded.rows.map((file) => file.source_attachment_id));
    for (const { row, entry } of pairs) {
      if (done.has(row.id)) continue;
      await storeRestoredFile(pool, blobStore, job, {
        sourceId: row.id,
        purpose: 'attachment',
        displayName: row.name,
        byteSize: row.byteSize,
        checksum: row.checksum,
        bytes: () => verifiedEntry(opened.archive, entry, row),
      });
      await hooks.afterFile?.(++stored);
    }
  }
  const icon = opened.manifest.community.icon;
  const iconEntry = opened.icon;
  if (icon && iconEntry) {
    const recorded = await pool.query(
      "SELECT 1 FROM community_import_files WHERE import_id=$1 AND purpose='icon'",
      [job.id]
    );
    if (!recorded.rowCount)
      await storeRestoredFile(pool, blobStore, job, {
        sourceId: ICON_SOURCE_ID,
        purpose: 'icon',
        displayName: 'community-icon',
        byteSize: icon.byteSize,
        checksum: icon.checksum,
        bytes: () => verifiedEntry(opened.archive, iconEntry, icon),
      });
  }
}

/** Record where the restore stands, in the batch's own transaction. */
async function saveProgress(client: PoolClient, importId: string, progress: Progress) {
  await client.query('UPDATE community_imports SET restore_progress=$2 WHERE id=$1', [
    importId,
    JSON.stringify(progress),
  ]);
}

/**
 * Restore a checked version 2 export in resumable batches.
 *
 * First every file is stored (as version 1 does; recorded files are skipped on a restart).
 * Then the rows, in dependency order (channels, members with their handles, agents with
 * theirs, the owner's channel memberships, messages with their mentions in channel and
 * sequence order, files, audit events), at most {@link RESTORE_BATCH_ROWS} rows per batch.
 * Each batch is one transaction that inserts its rows with derived IDs and
 * `ON CONFLICT DO NOTHING`, checks what the database cannot (see the writers), and records
 * how far the restore has come, so a restarted worker resumes at the next batch and writes
 * each row once. A row the insert skipped is a duplicate in the export, which fails it.
 *
 * The community stays unclaimed, with no member who can read it, until the final transaction
 * commits the files, fills in what version 2 carries beyond version 1 (the description and
 * admission policy the host left out, the icon), adds the owner to every channel when the
 * export gave them no membership, and marks the import ready. A failure anywhere takes the
 * usual abandon path, which removes everything the batches wrote.
 */
export async function restoreV2(
  pool: Pool,
  blobStore: BlobStore,
  job: ClaimedImport,
  row: ImportRow,
  source: RangeReader,
  limits: ImportLimits,
  hooks: ImportWorkerHooks
): Promise<void> {
  const communityId = row.community_id!;
  const opened = await openExportV2(source, limits);
  const { manifest } = opened;
  const context: V2Context = {
    pool,
    blobStore,
    job,
    opened,
    rules: new V2RowRules(manifest, limits, receivedAt(row)),
    maxLine: maxLineBytes(limits),
  };
  const scope: RestoreScope = {
    communityId,
    importId: job.id,
    derive: (sourceId) => uuidv5(job.id, sourceId),
    ownerSourceId: manifest.requesterMemberId,
  };
  let progress = row.restore_progress;
  if (!progress) {
    await restoreFiles(context, hooks);
    await hooks.beforeRows?.();
    progress = { step: 0, file: 0, line: 0 };
    const start = progress;
    await fenced(pool, job, (client) => saveProgress(client, job.id, start));
  }
  let batches = 0;
  const commit = async (
    step: (typeof STEPS)[number],
    rows: unknown[],
    next: Progress
  ): Promise<void> => {
    await fenced(pool, job, async (client) => {
      if (rows.length) await step.write(client, rows as never[], scope);
      await saveProgress(client, job.id, next);
    });
    await hooks.afterBatch?.(++batches);
  };
  for (let index = progress.step; index < STEPS.length; index++) {
    const step = STEPS[index];
    const from = index === progress.step ? progress : { step: index, file: 0, line: 0 };
    let rows: unknown[] = [];
    let rowWeight = 0;
    for await (const line of collectionLines(opened, step.key, context.maxLine, from)) {
      const parsed = context.rules.parse(step.key, line.bytes);
      rows.push(parsed);
      rowWeight += weight(step.key, parsed);
      if (rowWeight >= RESTORE_BATCH_ROWS) {
        await commit(step, rows, { step: index, file: line.file, line: line.line });
        rows = [];
        rowWeight = 0;
      }
    }
    await commit(step, rows, { step: index + 1, file: 0, line: 0 });
  }

  const expectedFiles = manifest.counts.attachments + (manifest.community.icon ? 1 : 0);
  await finishRestore(pool, job, communityId, expectedFiles, async (client) => {
    const ownerId = scope.derive(manifest.requesterMemberId);
    const owner = await client.query(
      "SELECT 1 FROM members WHERE community_id=$1 AND id=$2 AND role='owner'",
      [communityId, ownerId]
    );
    invalid(!owner.rowCount);
    // An owner export that gave its owner no channel membership still leaves them in every
    // channel, as version 1 does.
    await client.query(
      `INSERT INTO channel_members(community_id,channel_id,member_id)
       SELECT $1,c.id,$2 FROM channels c
       WHERE c.community_id=$1 AND NOT EXISTS(
         SELECT 1 FROM channel_members cm WHERE cm.community_id=$1 AND cm.member_id=$2)`,
      [communityId, ownerId]
    );
    const icon = await client.query<{ blob_key: string; content_type: string }>(
      "SELECT blob_key,content_type FROM community_import_files WHERE import_id=$1 AND purpose='icon'",
      [job.id]
    );
    // The host-supplied name always wins; the description and admission policy only fill in
    // what the create request left out.
    await client.query(
      `UPDATE communities SET
         description=CASE WHEN $2 THEN description ELSE $3 END,
         admission_policy=CASE WHEN $4 THEN admission_policy ELSE $5 END,
         icon_blob_key=$6,icon_content_type=$7
       WHERE id=$1`,
      [
        communityId,
        row.description_given,
        manifest.community.description,
        row.admission_policy_given,
        manifest.community.admissionPolicy,
        icon.rows[0]?.blob_key ?? null,
        icon.rows[0]?.content_type ?? null,
      ]
    );
    return ownerId;
  });
}
