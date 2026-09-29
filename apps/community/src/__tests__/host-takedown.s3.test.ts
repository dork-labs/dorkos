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

// Purpose (specs/community-host-takedown AC-4, AC-5): with S3 primary storage and an S3
// evidence bucket, a takedown copies the held file and record.json into the evidence bucket,
// the store refuses to overwrite a key, and the primary bucket then loses the file's bytes.

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
  const host = await bootstrapHost(h, 'Sky Host', 'sky@host.test');
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
