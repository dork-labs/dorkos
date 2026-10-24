import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
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
import { body, drainCleanup, post, upload } from './member-erasure-fixture.js';

// Purpose: removing a message, or one file of a message, deletes the file's bytes from S3 storage
// too, and no inventory row keeps their checksum, not only on the filesystem store (AC-2, AC-7).

const endpoint = process.env.COMMUNITY_TEST_S3_ENDPOINT;
const accessKeyId = process.env.COMMUNITY_TEST_S3_ACCESS_KEY;
const secretAccessKey = process.env.COMMUNITY_TEST_S3_SECRET_KEY;
if (!endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error('Disposable S3 settings are required for community S3 removal tests');
}
const bucket = `community-removal-${randomUUID()}`;
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
  h = await startTenancyHarness('removals3', {
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

it('deletes removed files from S3, whether the message or one file was removed', async () => {
  const host = await bootstrapHost(h, 'Sol Host', 'sol@host.test');
  const pending = await createPendingCommunity(h, host.cookie, 'Bucket');
  const owner = await claimAsNewAccount(h, pending.token, 'Bucket Owner', 'owner@bucket.test');
  const communityId = pending.communityId;
  const base = `/api/v1/communities/${communityId}`;
  const p = await admit(h, communityId, owner.cookie, { name: 'Pia', email: 'pia@bucket.test' });
  const channelId = await createChannel(h, communityId, owner.cookie, 'general', [p.cookie]);
  const files = [];
  for (const name of ['whole.txt', 'one.txt', 'kept.txt'])
    files.push(await upload(h, communityId, channelId, p.cookie, name, `canary-bytes ${name}`));
  const [whole, one, kept] = files;
  const wholeEntry = await post(
    h,
    communityId,
    channelId,
    { cookie: p.cookie },
    { text: 'whole', idempotencyKey: 'whole', attachmentIds: [whole] }
  );
  await post(
    h,
    communityId,
    channelId,
    { cookie: p.cookie },
    { text: 'two files', idempotencyKey: 'two', attachmentIds: [one, kept] }
  );
  const keyOf = async (id: string) =>
    (await h.pool.query<{ blob_key: string }>('SELECT blob_key FROM attachments WHERE id=$1', [id]))
      .rows[0].blob_key;
  const [wholeKey, oneKey, keptKey] = [await keyOf(whole), await keyOf(one), await keyOf(kept)];
  expect(await objectNames()).toEqual(expect.arrayContaining([wholeKey, oneKey, keptKey]));

  await body(
    await h.call(`${base}/entries/${wholeEntry.id}`, { method: 'DELETE', cookie: p.cookie }),
    200,
    'delete message'
  );
  await body(
    await h.call(`${base}/attachments/${one}`, { method: 'DELETE', cookie: owner.cookie }),
    200,
    'remove one file'
  );
  await drainCleanup(h);
  const left = await objectNames();
  expect(left).not.toContain(wholeKey);
  expect(left).not.toContain(oneKey);
  expect(left).toContain(keptKey);
  const keptObject = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keptKey }));
  expect(await keptObject.Body?.transformToString()).toBe('canary-bytes kept.txt');
  expect(
    (
      await h.pool.query('SELECT 1 FROM managed_blobs WHERE blob_key=ANY($1::text[])', [
        [wholeKey, oneKey],
      ])
    ).rowCount
  ).toBe(0);
});
