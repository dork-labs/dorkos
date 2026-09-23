import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { S3BlobStore } from '../storage/index.js';
import {
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createChannel,
  createPendingCommunity,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import {
  body,
  drainCleanup,
  hoursFromNow,
  PASSWORD,
  post,
  runErasures,
  upload,
} from './member-erasure-fixture.js';

// Purpose: erasure removes a person's file bytes and every live export from S3 storage too,
// and no inventory row keeps their checksums, not only on the filesystem store.

const endpoint = process.env.COMMUNITY_TEST_S3_ENDPOINT;
const accessKeyId = process.env.COMMUNITY_TEST_S3_ACCESS_KEY;
const secretAccessKey = process.env.COMMUNITY_TEST_S3_SECRET_KEY;
if (!endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error('Disposable S3 settings are required for community S3 erasure tests');
}
const bucket = `community-erasure-${randomUUID()}`;
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
let h: TenancyHarness;

async function objectNames(): Promise<string[]> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return (listed.Contents ?? []).flatMap((item) => (item.Key ? [item.Key] : []));
}

beforeAll(async () => {
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  h = await startTenancyHarness('erasures3', {
    blobStore: new S3BlobStore({
      bucket,
      region: 'us-east-1',
      endpoint,
      accessKeyId,
      secretAccessKey,
    }),
  });
});

afterAll(async () => {
  await h?.close();
  for (const name of await objectNames())
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: name }));
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  s3.destroy();
});

it('deletes the erased member’s objects and every live export from S3', async () => {
  const host = await bootstrapHost(h, 'Sam Host', 'sam@host.test');
  const pending = await createPendingCommunity(h, host.cookie, 'Bucket');
  const owner = await claimAsNewAccount(h, pending.token, 'Bucket Owner', 'owner@bucket.test');
  const communityId = pending.communityId;
  const p = await admit(h, communityId, owner.cookie, { name: 'Pia', email: 'pia@bucket.test' });
  const channelId = await createChannel(h, communityId, owner.cookie, 'general', [p.cookie]);
  const file = await upload(h, communityId, channelId, p.cookie, 'pia.txt', 'bytes of pia');
  await post(
    h,
    communityId,
    channelId,
    { cookie: p.cookie },
    {
      text: 'a file',
      idempotencyKey: 'pia-file',
      attachmentIds: [file],
    }
  );
  await body(
    await h.call(`/api/v1/communities/${communityId}/owner/export`, {
      cookie: owner.cookie,
      body: { password: PASSWORD },
    }),
    201,
    'owner export'
  );
  const blobs = (
    await h.pool.query<{ blob_key: string }>(
      'SELECT blob_key FROM managed_blobs WHERE community_id=$1',
      [communityId]
    )
  ).rows.map((row) => row.blob_key);
  expect(blobs).toHaveLength(2);
  expect((await objectNames()).filter((name) => blobs.includes(name))).toHaveLength(2);

  await body(
    await h.call('/api/v1/account/erasures', {
      cookie: p.cookie,
      body: { kind: 'membership', communityId, password: PASSWORD },
    }),
    201,
    'request erasure'
  );
  await runErasures(h.pool, hoursFromNow(73));
  await drainCleanup(h, [communityId]);
  expect((await objectNames()).filter((name) => blobs.includes(name))).toEqual([]);
  expect(
    (await h.pool.query('SELECT 1 FROM managed_blobs WHERE blob_key=ANY($1::text[])', [blobs]))
      .rowCount
  ).toBe(0);
});
