import { createHash, type Hash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ZipEntryInput } from '../archive/zip64-writer.js';
import { toArchiveSegment } from '../archive/zip-format.js';
import { sanitizeDisplayName } from '../storage/blob-store.js';
import { BlobStoreError, type BlobStore } from '../storage/index.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Messages read per query. */
export const PAGE_ROWS = 1_000;

/** A position in `(channel_id, seq)` order. */
export interface EntryCursor {
  channelId: string;
  seq: number;
}

/** An inclusive run of messages in `(channel_id, seq)` order. */
export interface EntryRange {
  first: EntryCursor;
  last: EntryCursor;
}

/**
 * Which messages an export covers: every channel of its watermark, up to the watermark's `seq`
 * in each, and for a personal export only the requester's own (or their agents').
 */
export interface EntryScope {
  communityId: string;
  /** Personal scope: the requester. Owner scope: null. */
  authorMemberId: string | null;
  /** Watermarked channels, sorted, and the highest exported `seq` in each. */
  channelIds: string[];
  seqs: number[];
}

/** Build an {@link EntryScope} from a stored watermark. */
export function entryScope(
  communityId: string,
  authorMemberId: string | null,
  watermark: Record<string, number>
): EntryScope {
  const channelIds = Object.keys(watermark).sort();
  return {
    communityId,
    authorMemberId,
    channelIds,
    seqs: channelIds.map((channelId) => watermark[channelId]),
  };
}

/** Before every message: `(channel_id, seq) > (nil, 0)` holds for all of them. */
export const START_CURSOR: EntryCursor = {
  channelId: '00000000-0000-0000-0000-000000000000',
  seq: 0,
};
const END_CURSOR: EntryCursor = {
  channelId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  seq: Number.MAX_SAFE_INTEGER,
};

/**
 * The messages of the scope after `after` (exclusive) and up to `until` (inclusive). Parameters:
 * `$1` community, `$2`/`$3` the watermark, `$4`/`$5` after, `$6`/`$7` until, `$8` the author for a
 * personal export (else null), `$9` the page size.
 */
const ENTRY_WHERE = `e.community_id=$1 AND e.channel_id=ANY($2::uuid[])
  AND e.seq <= (SELECT w.seq FROM unnest($2::uuid[],$3::bigint[]) AS w(channel_id,seq)
                WHERE w.channel_id=e.channel_id)
  AND (e.channel_id,e.seq) > ($4::uuid,$5::bigint)
  AND (e.channel_id,e.seq) <= ($6::uuid,$7::bigint)
  AND ($8::uuid IS NULL OR e.author_member_id=$8 OR e.author_agent_id IN (
    SELECT id FROM agents WHERE owner_member_id=$8 AND community_id=$1))`;

/** One page of messages; `(channel_id, seq)` is unique and indexed, so it is one range scan. */
function entryPageSql(columns: string): string {
  return `SELECT ${columns} FROM entries e WHERE ${ENTRY_WHERE}
    ORDER BY e.channel_id,e.seq LIMIT $9`;
}

function pageParams(scope: EntryScope, after: EntryCursor, until: EntryCursor, limit = PAGE_ROWS) {
  return [
    scope.communityId,
    scope.channelIds,
    scope.seqs,
    after.channelId,
    after.seq,
    until.channelId,
    until.seq,
    scope.authorMemberId,
    limit,
  ];
}

/** The cursor just before a range's first message. */
function beforeRange(range: EntryRange): EntryCursor {
  return { channelId: range.first.channelId, seq: range.first.seq - 1 };
}

/** Iterate pages of the range's messages with the given columns (which include channel and seq). */
async function* entryPages<T extends { channel_id: string; seq: string }>(
  db: Queryable,
  scope: EntryScope,
  range: EntryRange,
  columns: string
): AsyncGenerator<T[]> {
  if (!scope.channelIds.length) return;
  let after = beforeRange(range);
  while (true) {
    const page = await db.query<T>(entryPageSql(columns), pageParams(scope, after, range.last));
    if (!page.rows.length) return;
    yield page.rows;
    const tail = page.rows[page.rows.length - 1];
    after = { channelId: tail.channel_id, seq: Number(tail.seq) };
    if (page.rows.length < PAGE_ROWS) return;
  }
}

/** Messages plus their files in the scope: the total a job's progress counts toward. */
export async function countScope(db: Queryable, scope: EntryScope): Promise<number> {
  if (!scope.channelIds.length) return 0;
  const result = await db.query<{ total: string }>(
    `SELECT (count(*) + COALESCE(sum((SELECT count(*) FROM attachments a
               WHERE a.entry_id=e.id AND a.community_id=$1)),0))::text AS total
     FROM entries e WHERE ${ENTRY_WHERE} AND $9::int > 0`,
    pageParams(scope, START_CURSOR, END_CURSOR, 1)
  );
  return Number(result.rows[0].total);
}

/**
 * Find the next data segment's range after `after`: messages are added in order while the
 * estimated size (text and header overhead, plus each message's files) stays within
 * `targetBytes`. A segment always takes at least one message. Returns null when none is left.
 */
export async function planDataSegment(
  db: Queryable,
  scope: EntryScope,
  after: EntryCursor,
  targetBytes: number
): Promise<EntryRange | null> {
  if (!scope.channelIds.length) return null;
  let first: EntryCursor | null = null;
  let last: EntryCursor | null = null;
  let total = 0;
  let cursor = after;
  while (true) {
    const page = await db.query<{ channel_id: string; seq: string; estimate: string }>(
      entryPageSql(
        `e.channel_id,e.seq::text AS seq,
         (octet_length(e.text)+octet_length(e.author_display_name)+512
          + COALESCE((SELECT sum(a.byte_size + 2*octet_length(a.display_name) + 768)
                      FROM attachments a WHERE a.entry_id=e.id AND a.community_id=$1),0))::text
           AS estimate`
      ),
      pageParams(scope, cursor, END_CURSOR)
    );
    for (const row of page.rows) {
      const estimate = Number(row.estimate);
      const position = { channelId: row.channel_id, seq: Number(row.seq) };
      if (first && total + estimate > targetBytes) return { first, last: last! };
      first ??= position;
      last = position;
      total += estimate;
    }
    if (page.rows.length < PAGE_ROWS) return first ? { first, last: last! } : null;
    cursor = last!;
  }
}

interface EntrySqlRow {
  id: string;
  channel_id: string;
  seq: string;
  author_member_id: string | null;
  author_agent_id: string | null;
  author_display_name: string;
  text: string;
  mentions: string[];
  parent_entry_id: string | null;
  thread_root_entry_id: string | null;
  created_at: Date;
  removed_by: 'author' | 'moderator' | 'host' | null;
  removed_at: Date | null;
  erased_at: Date | null;
  payload_hash: string;
}

const ENTRY_COLUMNS = `e.id,e.channel_id,e.seq::text AS seq,e.author_member_id,e.author_agent_id,
  e.author_display_name,e.text,
  COALESCE((SELECT array_agg(COALESCE(em.mentioned_member_id,em.mentioned_agent_id) ORDER BY em.position)
            FROM entry_mentions em WHERE em.entry_id=e.id AND em.community_id=$1),'{}'::uuid[]) AS mentions,
  e.parent_entry_id,e.thread_root_entry_id,e.created_at,e.removed_by,e.removed_at,e.erased_at,
  e.payload_hash`;

const DIGEST_COLUMNS =
  'e.id,e.channel_id,e.seq::text AS seq,e.payload_hash,e.removed_at,e.erased_at';

interface AttachmentSqlRow {
  id: string;
  channel_id: string;
  entry_id: string;
  uploader_member_id: string | null;
  uploader_agent_id: string | null;
  display_name: string;
  content_type: string;
  byte_size: number;
  checksum: string;
  uploaded_at: Date;
  blob_key: string;
}

/** Files of a page of messages, in message order, then by id. */
async function attachmentsOf(
  db: Queryable,
  communityId: string,
  entryIds: string[]
): Promise<AttachmentSqlRow[]> {
  const result = await db.query<AttachmentSqlRow>(
    `SELECT att.id,att.channel_id,att.entry_id,att.uploader_member_id,att.uploader_agent_id,
            att.display_name,att.content_type,att.byte_size,att.checksum,att.uploaded_at,att.blob_key
     FROM attachments att
     JOIN unnest($2::uuid[]) WITH ORDINALITY AS page(entry_id,position) ON page.entry_id=att.entry_id
     WHERE att.community_id=$1
     ORDER BY page.position,att.id`,
    [communityId, entryIds]
  );
  return result.rows;
}

/** Where a file's bytes live in the archive: one folder per file, the display name inside it. */
export function attachmentArchivePath(id: string, displayName: string): string {
  return `files/${id}/${toArchiveSegment(sanitizeDisplayName(displayName))}`;
}

/** Six-digit file number used in archive entry names. */
export function fileNumber(n: number): string {
  return String(n).padStart(6, '0');
}

function digestEntry(
  hash: Hash,
  row: Pick<EntrySqlRow, 'id' | 'payload_hash' | 'removed_at' | 'erased_at'>
) {
  hash.update(
    `e:${row.id}:${row.payload_hash}:${row.removed_at?.toISOString() ?? ''}:${row.erased_at?.toISOString() ?? ''}\n`
  );
}

function digestFile(hash: Hash, id: string) {
  hash.update(`f:${id}\n`);
}

/**
 * The digest a data segment stores: SHA-256 over its messages' `(id, payload_hash, removed_at,
 * erased_at)` and its files' ids, in archive order. A removal, erasure or takedown replaces the
 * payload hash and sets a timestamp, and a deleted file drops out, so each changes the digest. A
 * text change that keeps the payload hash (erasure's mention rewrite on someone else's message)
 * does not; that one is caught by its redaction row instead.
 */
export async function digestDataRange(
  db: Queryable,
  scope: EntryScope,
  range: EntryRange
): Promise<string> {
  const hash = createHash('sha256');
  const fileIds: string[][] = [];
  for await (const page of entryPages<EntrySqlRow>(db, scope, range, DIGEST_COLUMNS)) {
    for (const row of page) digestEntry(hash, row);
    fileIds.push(
      (
        await attachmentsOf(
          db,
          scope.communityId,
          page.map((row) => row.id)
        )
      ).map((row) => row.id)
    );
  }
  for (const ids of fileIds) for (const id of ids) digestFile(hash, id);
  return hash.digest('hex');
}

/** A file vanished (row or bytes) while its segment was being written: write the segment again. */
export class SegmentChangedError extends Error {
  constructor() {
    super('The content of an export segment changed while it was written');
    this.name = 'SegmentChangedError';
  }
}

/** What one data segment holds once its entries have been written. */
export interface DataSegmentTally {
  entryCount: number;
  fileCount: number;
  digest: string | null;
}

/** Everything needed to write one data segment. */
export interface DataSegmentInput {
  db: Queryable;
  blobStore: BlobStore;
  scope: EntryScope;
  range: EntryRange;
  segmentNo: number;
  /** Called before each file's bytes are opened. */
  beforeFile?: (attachmentId: string) => Promise<void>;
}

function toEntryLine(row: EntrySqlRow): string {
  return `${JSON.stringify({
    id: row.id,
    channel_id: row.channel_id,
    seq: Number(row.seq),
    author_member_id: row.author_member_id,
    author_agent_id: row.author_agent_id,
    author_display_name: row.author_display_name,
    text: row.text,
    mentions: row.mentions,
    parent_entry_id: row.parent_entry_id,
    thread_root_entry_id: row.thread_root_entry_id,
    created_at: row.created_at.toISOString(),
    // Erasure wins over a removal, as it does in the entry itself.
    removal: row.erased_at ? 'erased' : row.removed_by,
  })}\n`;
}

function toAttachmentLine(row: AttachmentSqlRow): string {
  return `${JSON.stringify({
    id: row.id,
    channelId: row.channel_id,
    entryId: row.entry_id,
    uploaderMemberId: row.uploader_member_id,
    uploaderAgentId: row.uploader_agent_id,
    name: row.display_name,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    checksum: row.checksum,
    uploadedAt: row.uploaded_at.toISOString(),
    archivePath: attachmentArchivePath(row.id, row.display_name),
  })}\n`;
}

const encoder = new TextEncoder();

/**
 * The entries of one data segment, in order: `entries/NNNNNN.ndjson`, then (when it has files)
 * `attachments/NNNNNN.ndjson`, then each file's bytes. Messages are read in pages from the
 * database as the writer consumes them, so memory holds one page and one file at a time.
 *
 * The files are read twice, once for their metadata and once for their bytes. When the two reads
 * disagree, or a file's bytes are gone, the segment throws {@link SegmentChangedError} so the
 * caller discards it and writes it again from current rows. `tally` is complete once the last
 * entry has been consumed.
 */
export async function* dataSegmentEntries(
  input: DataSegmentInput,
  tally: DataSegmentTally
): AsyncGenerator<ZipEntryInput> {
  const { db, scope, range } = input;
  const number = fileNumber(input.segmentNo);
  const digest = createHash('sha256');
  tally.entryCount = 0;
  tally.fileCount = 0;
  tally.digest = null;

  yield {
    name: `entries/${number}.ndjson`,
    method: 'deflated',
    source: (async function* () {
      for await (const page of entryPages<EntrySqlRow>(db, scope, range, ENTRY_COLUMNS)) {
        const lines: string[] = [];
        for (const row of page) {
          digestEntry(digest, row);
          lines.push(toEntryLine(row));
        }
        tally.entryCount += page.length;
        yield encoder.encode(lines.join(''));
      }
    })(),
  };

  const listed = createHash('sha256');
  const hasFiles = await db.query(
    `SELECT 1 FROM attachments att JOIN entries e ON e.id=att.entry_id
     WHERE att.community_id=$1 AND ${ENTRY_WHERE} LIMIT $9`,
    pageParams(scope, beforeRange(range), range.last, 1)
  );
  if (hasFiles.rowCount) {
    yield {
      name: `attachments/${number}.ndjson`,
      method: 'deflated',
      source: (async function* () {
        for await (const page of entryPages<{ id: string; channel_id: string; seq: string }>(
          db,
          scope,
          range,
          'e.id,e.channel_id,e.seq::text AS seq'
        )) {
          const files = await attachmentsOf(
            db,
            scope.communityId,
            page.map((row) => row.id)
          );
          if (!files.length) continue;
          for (const file of files) {
            digestFile(digest, file.id);
            digestFile(listed, file.id);
          }
          tally.fileCount += files.length;
          yield encoder.encode(files.map(toAttachmentLine).join(''));
        }
      })(),
    };
  }

  // The attachments file exists exactly when the segment has files, so the manifest can name it
  // from the segment's file count. Files that all vanished since the check are a change.
  if (hasFiles.rowCount && tally.fileCount === 0) throw new SegmentChangedError();
  const written = createHash('sha256');
  for await (const page of entryPages<{ id: string; channel_id: string; seq: string }>(
    db,
    scope,
    range,
    'e.id,e.channel_id,e.seq::text AS seq'
  )) {
    for (const file of await attachmentsOf(
      db,
      scope.communityId,
      page.map((row) => row.id)
    )) {
      digestFile(written, file.id);
      await input.beforeFile?.(file.id);
      let body;
      try {
        body = (await input.blobStore.get(file.blob_key)).body;
      } catch (error) {
        if (error instanceof BlobStoreError && error.code === 'BLOB_NOT_FOUND')
          throw new SegmentChangedError();
        throw error;
      }
      yield {
        name: attachmentArchivePath(file.id, file.display_name),
        method: 'stored',
        size: Number(file.byte_size),
        source: body,
      };
    }
  }
  if (written.digest('hex') !== listed.digest('hex')) throw new SegmentChangedError();
  tally.digest = digest.digest('hex');
}
