import { createHash, randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CommunityEvidenceRecordV1Schema } from '@dorkos/shared/community-admin-wire';
import { createEvidenceSink, EvidenceSinkError } from '../takedown/evidence/sink.js';
import { S3BlobStore } from '../storage/index.js';
import { copyDueTakedownEvidence } from '../takedown/worker.js';
import {
  bootstrapHost,
  TENANCY_PASSWORD,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import { body, drainCleanup, post, upload } from './member-erasure-fixture.js';
import { makeScene } from './member-erasure-scenes.js';
import { drainExports, openArchive } from './export-test-helpers.js';

// Purpose (specs/community-host-takedown AC-4, AC-5, AC-8): with S3 primary storage and an S3
// evidence bucket, a takedown copies the held file and record.json into the evidence bucket,
// the store refuses to overwrite a key, and the primary bucket then loses the file's bytes. A
// whole community's evidence export is built in the primary bucket, copied segment by segment
// into the evidence bucket, and then leaves the primary bucket.

const endpoint = process.env.COMMUNITY_TEST_S3_ENDPOINT;
const accessKeyId = process.env.COMMUNITY_TEST_S3_ACCESS_KEY;
const secretAccessKey = process.env.COMMUNITY_TEST_S3_SECRET_KEY;
if (!endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error('Disposable S3 settings are required for community S3 takedown tests');
}
const primary = `community-takedown-${randomUUID()}`;
const evidence = `community-evidence-${randomUUID()}`;
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
let h: TenancyHarness;
let host: { cookie: string; communityId: string };

async function names(bucket: string): Promise<string[]> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return (listed.Contents ?? []).flatMap((item) => (item.Key ? [item.Key] : []));
}

async function read(bucket: string, key: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await result.Body!.transformToByteArray());
}

beforeAll(async () => {
  await s3.send(new CreateBucketCommand({ Bucket: primary }));
  await s3.send(new CreateBucketCommand({ Bucket: evidence }));
  h = await startTenancyHarness('takedowns3', {
    blobStore: new S3BlobStore({
      bucket: primary,
      region: 'us-east-1',
      endpoint,
      accessKeyId,
      secretAccessKey,
    }),
    env: {
      COMMUNITY_EVIDENCE_DRIVER: 's3',
      COMMUNITY_EVIDENCE_S3_BUCKET: evidence,
      COMMUNITY_EVIDENCE_S3_REGION: 'us-east-1',
      COMMUNITY_EVIDENCE_S3_ENDPOINT: endpoint,
      COMMUNITY_EVIDENCE_S3_ACCESS_KEY_ID: accessKeyId,
      COMMUNITY_EVIDENCE_S3_SECRET_ACCESS_KEY: secretAccessKey,
      COMMUNITY_EVIDENCE_S3_PREFIX: 'host-a',
    },
  });
});

afterAll(async () => {
  await h?.close();
  for (const bucket of [primary, evidence]) {
    for (const name of await names(bucket))
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: name }));
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
  s3.destroy();
});

it('copies a takedown into the evidence bucket, never overwrites, then deletes the primary bytes', async () => {
  host = await bootstrapHost(h, 'Sky Host', 'sky@host.test');
  const s = await makeScene(h, host.cookie, 's3');
  const bytes = 'canary-bytes-s3';
  const fileId = await upload(h, s.communityId, s.channelId, s.p.cookie, 'canary-s3.txt', bytes);
  const entry = await post(
    h,
    s.communityId,
    s.channelId,
    { cookie: s.p.cookie },
    {
      text: 'canary-text-s3',
      idempotencyKey: 'canary-s3',
      attachmentIds: [fileId],
    }
  );
  const fileKey = (
    await h.pool.query<{ blob_key: string }>('SELECT blob_key FROM attachments WHERE id=$1', [
      fileId,
    ])
  ).rows[0].blob_key;
  const { takedown } = await body<{ takedown: { id: string; evidence: { state: string } } }>(
    await h.call(`/api/v1/host/communities/${s.communityId}/takedowns`, {
      cookie: host.cookie,
      body: {
        idempotencyKey: 'takedown-s3',
        target: { kind: 'entry', entryId: entry.id },
        category: 'illegal_content',
        reference: null,
        password: TENANCY_PASSWORD,
      },
    }),
    201,
    'takedown'
  );
  expect(takedown.evidence.state).toBe('pending');
  const sink = createEvidenceSink(h.config.evidence)!;
  expect(await copyDueTakedownEvidence(h.pool, h.blobStore, sink, { warn: () => {} })).toEqual({
    claimed: true,
    stored: true,
  });
  const folder = `host-a/takedowns/${takedown.id}/attempt-1/`;
  expect((await names(evidence)).sort()).toEqual(
    [`${folder}files/${fileId}`, `${folder}record.json`].sort()
  );
  expect((await read(evidence, `${folder}files/${fileId}`)).toString()).toBe(bytes);
  const recordBytes = await read(evidence, `${folder}record.json`);
  expect(
    CommunityEvidenceRecordV1Schema.parse(JSON.parse(recordBytes.toString())).entry?.text
  ).toBe('canary-text-s3');
  const stored = await h.pool.query<{ evidence_record_sha256: string }>(
    'SELECT evidence_record_sha256 FROM community_takedowns WHERE id=$1',
    [takedown.id]
  );
  expect(stored.rows[0].evidence_record_sha256).toBe(
    createHash('sha256').update(recordBytes).digest('hex')
  );
  // The store answers a second write to the same key with a refusal, and keeps the first.
  const other = Buffer.from('replacement');
  await expect(
    sink.put(`takedowns/${takedown.id}/attempt-1/record.json`, [other], {
      sha256: createHash('sha256').update(other).digest('hex'),
      byteSize: other.length,
    })
  ).rejects.toEqual(new EvidenceSinkError('EVIDENCE_EXISTS'));
  expect(await read(evidence, `${folder}record.json`)).toEqual(recordBytes);
  // Primary storage then loses the file.
  await drainCleanup(h);
  expect(await names(primary)).not.toContain(fileKey);
});

it('copies a whole community into the evidence bucket, then drops its evidence export', async () => {
  const s = await makeScene(h, host.cookie, 's3whole');
  const version = (
    await h.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [s.communityId]
    )
  ).rows[0].lifecycle_version;
  const { takedown } = await body<{ takedown: { id: string } }>(
    await h.call(`/api/v1/host/communities/${s.communityId}/takedowns`, {
      cookie: host.cookie,
      body: {
        idempotencyKey: 'takedown-s3-whole',
        target: {
          kind: 'community',
          lifecycleVersion: version,
          confirmIdSuffix: s.communityId.slice(-8),
        },
        category: 'legal_order',
        reference: null,
        password: TENANCY_PASSWORD,
      },
    }),
    201,
    'community takedown'
  );
  await drainExports(h.pool, h.blobStore);
  const segmentKeys = (
    await h.pool.query<{ blob_key: string }>(
      `SELECT s.blob_key FROM export_segments s JOIN export_archives e ON e.id=s.export_id
       WHERE e.evidence_takedown_id=$1`,
      [takedown.id]
    )
  ).rows.map((row) => row.blob_key);
  expect(segmentKeys.length).toBeGreaterThan(0);
  expect(await names(primary)).toEqual(expect.arrayContaining(segmentKeys));
  const sink = createEvidenceSink(h.config.evidence)!;
  expect(await copyDueTakedownEvidence(h.pool, h.blobStore, sink, { warn: () => {} })).toEqual({
    claimed: true,
    stored: true,
  });
  const folder = `host-a/takedowns/${takedown.id}/attempt-1/`;
  const written = (await names(evidence)).filter((name) => name.startsWith(folder)).sort();
  expect(written).toEqual(
    [
      ...segmentKeys.map(
        (_, index) => `${folder}archive.zip.${String(index + 1).padStart(6, '0')}`
      ),
      `${folder}record.json`,
    ].sort()
  );
  const record = CommunityEvidenceRecordV1Schema.parse(
    JSON.parse((await read(evidence, `${folder}record.json`)).toString())
  );
  const archive = await openArchive(
    Buffer.concat(
      await Promise.all(
        record.archive!.segments.map((segment) => read(evidence, `${folder}${segment.path}`))
      )
    )
  );
  expect(archive.manifest.scope).toBe('evidence');
  // The evidence export leaves the primary bucket once copied.
  await drainCleanup(h);
  const left = await names(primary);
  for (const key of segmentKeys) expect(left).not.toContain(key);
});
