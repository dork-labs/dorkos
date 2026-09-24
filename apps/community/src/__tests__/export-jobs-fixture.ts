import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { CommunityWireExport } from '@dorkos/shared/community-wire';
import { runNextExport, type ExportWorkerHooks } from '../exports/worker.js';
import type { BlobStore } from '../storage/index.js';
import {
  admit,
  claimAsNewAccount,
  createChannel,
  createPendingCommunity,
  expectStatus,
  TENANCY_PASSWORD,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

/** One community with an owner and a first channel, created through the host API. */
export interface ExportCommunity {
  communityId: string;
  base: string;
  owner: TenancyMember;
  channelId: string;
}

/** Create a community for one test, so no test sees another's exports or content. */
export async function exportCommunity(
  h: TenancyHarness,
  operatorCookie: string,
  label: string
): Promise<ExportCommunity> {
  const { communityId, token } = await createPendingCommunity(h, operatorCookie, label);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await claimAsNewAccount(h, token, `${label} Owner`, `${slug}-owner@export.test`);
  const channelId = await createChannel(h, communityId, owner.cookie, 'general');
  return { communityId, base: `/api/v1/communities/${communityId}`, owner, channelId };
}

/** Admit one more member and join them to the community's first channel. */
export async function exportMember(
  h: TenancyHarness,
  community: ExportCommunity,
  name: string
): Promise<TenancyMember> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 6)}@export.test`;
  const member = await admit(h, community.communityId, community.owner.cookie, { name, email });
  await expectStatus(
    await h.call(`${community.base}/channels/${community.channelId}/join`, {
      cookie: member.cookie,
      body: {},
    }),
    200,
    `join ${name}`
  );
  return member;
}

/**
 * Insert `count` messages at the end of a channel directly, far faster than posting them. The
 * text of message `n` is `textOf(n)`.
 */
export async function seedEntries(
  h: TenancyHarness,
  community: ExportCommunity,
  options: {
    channelId?: string;
    authorMemberId: string;
    count: number;
    textOf?: (n: number) => string;
  }
): Promise<{ id: string; seq: number }[]> {
  const channelId = options.channelId ?? community.channelId;
  const base = Number(
    (
      await h.pool.query<{ last_seq: string }>('SELECT last_seq FROM channels WHERE id=$1', [
        channelId,
      ])
    ).rows[0].last_seq
  );
  const texts = Array.from({ length: options.count }, (_, index) =>
    (options.textOf ?? ((n: number) => `message ${n}`))(base + index + 1)
  );
  const inserted = await h.pool.query<{ id: string; seq: string }>(
    `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_display_name,text,
       idempotency_key,payload_hash)
     SELECT $1,$2,$3::bigint+item.n,$4,'Seeded',item.text,'seed-'||gen_random_uuid()::text,
            md5(item.text)
     FROM unnest($5::text[]) WITH ORDINALITY AS item(text,n)
     RETURNING id,seq::text`,
    [community.communityId, channelId, base, options.authorMemberId, texts]
  );
  await h.pool.query('UPDATE channels SET last_seq=$2 WHERE id=$1', [
    channelId,
    base + options.count,
  ]);
  return inserted.rows
    .map((row) => ({ id: row.id, seq: Number(row.seq) }))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Store one file and bind it to a message directly. `bytes` is the content, or a size to fill
 * with a repeated pattern (streamed, so a 25 MiB file never sits in memory twice).
 */
export async function seedFile(
  h: TenancyHarness,
  community: ExportCommunity,
  options: {
    entryId: string;
    uploaderMemberId: string;
    name: string;
    bytes: Buffer | number;
    channelId?: string;
  }
): Promise<{ id: string; blobKey: string; checksum: string; byteSize: number }> {
  const size = typeof options.bytes === 'number' ? options.bytes : options.bytes.length;
  const source =
    typeof options.bytes === 'number'
      ? (async function* () {
          const block = Buffer.alloc(1024 * 1024, `${options.name} `);
          for (let written = 0; written < size; written += block.length)
            yield block.subarray(0, Math.min(block.length, size - written));
        })()
      : (async function* (bytes: Buffer) {
          yield bytes;
        })(options.bytes);
  const stored = await h.blobStore.put({
    source,
    displayName: options.name,
    maxBytes: 25 * 1024 * 1024,
    kind: 'attachment',
  });
  const lifecycle = await h.pool.query<{ lifecycle_version: number }>(
    'SELECT lifecycle_version FROM communities WHERE id=$1',
    [community.communityId]
  );
  await h.pool.query(
    `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state,
       byte_size,checksum,stored_at,committed_at)
     VALUES($1,$2,'attachment',$3,'committed',$4,$5,now(),now())`,
    [
      stored.key,
      community.communityId,
      lifecycle.rows[0].lifecycle_version,
      stored.byteSize,
      stored.sha256,
    ]
  );
  const attachment = await h.pool.query<{ id: string }>(
    `INSERT INTO attachments(community_id,channel_id,uploader_member_id,entry_id,blob_key,
       display_name,content_type,byte_size,checksum)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      community.communityId,
      options.channelId ?? community.channelId,
      options.uploaderMemberId,
      options.entryId,
      stored.key,
      options.name,
      stored.contentType,
      stored.byteSize,
      stored.sha256,
    ]
  );
  return {
    id: attachment.rows[0].id,
    blobKey: stored.key,
    checksum: stored.sha256,
    byteSize: stored.byteSize,
  };
}

/** Ask for an owner export (with the password) and return the answer's status and export. */
export async function requestOwnerExport(
  h: TenancyHarness,
  community: ExportCommunity,
  cookie = community.owner.cookie
): Promise<{ status: number; export: CommunityWireExport }> {
  const response = await h.call(`${community.base}/owner/export`, {
    cookie,
    body: { password: TENANCY_PASSWORD },
  });
  const body = await response.json();
  if (!body.export) throw new Error(`Export answered ${response.status}: ${JSON.stringify(body)}`);
  return { status: response.status, export: body.export };
}

/** Ask for a personal export and return the answer's status and export. */
export async function requestPersonalExport(
  h: TenancyHarness,
  community: ExportCommunity,
  cookie: string
): Promise<{ status: number; export: CommunityWireExport }> {
  const response = await h.call(`${community.base}/me/export`, { cookie, body: {} });
  const body = await response.json();
  if (!body.export) throw new Error(`Export answered ${response.status}: ${JSON.stringify(body)}`);
  return { status: response.status, export: body.export };
}

/** Read one export's status as its requester. */
export async function exportStatus(
  h: TenancyHarness,
  community: ExportCommunity,
  id: string,
  cookie = community.owner.cookie
): Promise<CommunityWireExport> {
  const response = await expectStatus(
    await h.call(`${community.base}/exports/${id}`, { cookie }),
    200,
    'export status'
  );
  return (await response.json()).export;
}

/** Download a whole ready archive. */
export async function downloadArchive(
  h: TenancyHarness,
  community: ExportCommunity,
  id: string,
  cookie = community.owner.cookie
): Promise<Buffer> {
  const response = await expectStatus(
    await h.call(`${community.base}/exports/${id}/archive`, { cookie }),
    200,
    'archive download'
  );
  return Buffer.from(await response.arrayBuffer());
}

/** Run one export job with the given worker options (small segments by default). */
export function runExport(
  h: TenancyHarness,
  options: {
    segmentBytes?: number;
    maxHours?: number;
    ttlHours?: number;
    now?: () => Date;
    hooks?: ExportWorkerHooks;
    blobStore?: BlobStore;
    pool?: TenancyHarness['pool'];
  } = {}
): Promise<string | null> {
  return runNextExport({
    pool: options.pool ?? h.pool,
    blobStore: options.blobStore ?? h.blobStore,
    settings: {
      segmentBytes: options.segmentBytes ?? 256 * 1024 * 1024,
      ttlHours: options.ttlHours ?? 24,
      maxHours: options.maxHours ?? 24,
    },
    now: options.now,
    hooks: options.hooks,
  });
}

/** The export's committed segments, in archive order. */
export async function segmentsOf(
  h: TenancyHarness,
  exportId: string
): Promise<{ segment_no: number; kind: string; blob_key: string; byte_size: number }[]> {
  const result = await h.pool.query<{
    segment_no: number;
    kind: string;
    blob_key: string;
    byte_size: string;
  }>(
    'SELECT segment_no,kind,blob_key,byte_size::text FROM export_segments WHERE export_id=$1 ORDER BY segment_no',
    [exportId]
  );
  return result.rows.map((row) => ({ ...row, byte_size: Number(row.byte_size) }));
}

/** One job's row, for state assertions. */
export async function jobRow(
  h: TenancyHarness,
  exportId: string
): Promise<{ state: string; failure_code: string | null; rebuild_passes: number }> {
  const result = await h.pool.query(
    'SELECT state,failure_code,rebuild_passes FROM export_archives WHERE id=$1',
    [exportId]
  );
  return result.rows[0];
}

/**
 * Every export-purpose blob of a community that is neither referenced by a segment row nor
 * queued for deletion: an orphan the cleanup would never find.
 */
export async function orphanExportBlobs(h: TenancyHarness, communityId: string): Promise<string[]> {
  const result = await h.pool.query<{ blob_key: string }>(
    `SELECT m.blob_key FROM managed_blobs m
     WHERE m.community_id=$1 AND m.purpose='export' AND m.state<>'pending_delete'
       AND NOT EXISTS (SELECT 1 FROM export_segments s WHERE s.blob_key=m.blob_key)
       AND NOT EXISTS (SELECT 1 FROM export_archives e WHERE e.blob_key=m.blob_key)`,
    [communityId]
  );
  return result.rows.map((row) => row.blob_key);
}

/** Wait until `check` is true, polling the database. */
export async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** SHA-256 of some bytes, as hex. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A promise that never settles: a worker that reaches it behaves as if its process died. */
export function forever(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** Assert an archive's NDJSON rows and file names are each present exactly once. */
export function expectUnique(values: readonly string[], what: string): void {
  expect(new Set(values).size, `${what} are unique`).toBe(values.length);
}
