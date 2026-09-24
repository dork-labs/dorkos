import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sweepImports } from '../imports/worker.js';
import { S3BlobStore } from '../storage/index.js';
import { drainCleanup } from './member-erasure-fixture.js';
import {
  buildArchive,
  createImport,
  issueKey,
  minimalManifest,
  sha256,
  uploadArchive,
} from './import-fixture.js';
import {
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

// Purpose: an import's uploaded export lands in S3 storage like any other file, and cancelling
// the import removes it from the bucket too, not only on the filesystem store.

const endpoint = process.env.COMMUNITY_TEST_S3_ENDPOINT;
const accessKeyId = process.env.COMMUNITY_TEST_S3_ACCESS_KEY;
const secretAccessKey = process.env.COMMUNITY_TEST_S3_SECRET_KEY;
if (!endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error('Disposable S3 settings are required for community S3 import tests');
}
const bucket = `community-import-${randomUUID()}`;
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
  h = await startTenancyHarness('imports3', {
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

it('stores an uploaded export in S3 and removes it when the import is cancelled', async () => {
  await bootstrapHost(h, 'Sam Host', 'sam@host.test');
  const key = await issueKey(h, ['communities:import']);
  const before = new Set(await objectNames());
  const { importId, communityId, uploadToken } = await createImport(h, { bearer: key });
  await expectStatus(
    await uploadArchive(h, importId, buildArchive(minimalManifest()), { bearer: uploadToken }),
    200,
    'upload'
  );
  const staging = await h.pool.query<{ blob_key: string }>(
    "SELECT blob_key FROM managed_blobs WHERE community_id=$1 AND purpose='import_staging'",
    [communityId]
  );
  expect(await objectNames()).toContain(staging.rows[0].blob_key);

  await expectStatus(
    await h.call(`/api/v1/host/imports/${importId}/cancel`, { bearer: key, body: {} }),
    200,
    'cancel'
  );
  for (let round = 0; round < 5; round++) {
    await h.pool.query(
      'UPDATE community_imports SET next_attempt_at=now() WHERE settled_at IS NULL'
    );
    await drainCleanup(h);
    if (!(await sweepImports(h.pool, h.blobStore, h.config.limits)).claimed) break;
  }
  expect(new Set(await objectNames())).toEqual(before);
  expect(
    (await h.pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId])).rowCount
  ).toBe(0);
});

// Purpose: a restored file is stored in S3 under its own new key, verified against the
// export, and removed from the bucket when the host abandons the unclaimed community.
it('restores an export’s files into S3 and removes them when the community is abandoned', async () => {
  const key = await issueKey(h, ['communities:import', 'communities:write']);
  const manifest = minimalManifest();
  const owner = manifest.requesterMemberId;
  const channel = '00000000-0000-4000-8000-0000000000a1';
  const entry = '00000000-0000-4000-8000-0000000000e1';
  const file = '00000000-0000-4000-8000-0000000000f1';
  const bytes = Buffer.from('bytes kept in the bucket');
  manifest.channels = [
    {
      id: channel,
      name: 'general',
      description: null,
      visibility: 'public',
      archived: false,
      created_at: '2026-01-02T03:04:05.000Z',
    },
  ];
  manifest.entries = [
    {
      id: entry,
      channel_id: channel,
      seq: '1',
      author_member_id: owner,
      author_agent_id: null,
      author_display_name: 'Ada Owner',
      text: 'see file',
      mentions: [],
      parent_entry_id: null,
      thread_root_entry_id: null,
      created_at: '2026-01-02T03:04:05.000Z',
    },
  ];
  manifest.attachments = [
    {
      id: file,
      channelId: channel,
      entryId: entry,
      uploaderMemberId: owner,
      uploaderAgentId: null,
      name: 'note.txt',
      contentType: 'text/plain; charset=utf-8',
      byteSize: bytes.length,
      checksum: sha256(bytes),
      uploadedAt: '2026-01-02T03:04:05.000Z',
      archivePath: `attachments/${file}`,
    },
  ];
  const before = new Set(await objectNames());
  const { importId, communityId, uploadToken } = await createImport(
    h,
    { bearer: key },
    { autoCommit: true }
  );
  await expectStatus(
    await uploadArchive(h, importId, buildArchive(manifest, new Map([[file, bytes]])), {
      bearer: uploadToken,
    }),
    200,
    'upload'
  );
  for (let round = 0; round < 5; round++) {
    await h.pool.query(
      'UPDATE community_imports SET next_attempt_at=now() WHERE settled_at IS NULL'
    );
    await drainCleanup(h);
    if (!(await sweepImports(h.pool, h.blobStore, h.config.limits)).claimed) break;
  }
  const restored = await h.pool.query<{ blob_key: string }>(
    'SELECT blob_key FROM attachments WHERE community_id=$1',
    [communityId]
  );
  expect(restored.rows).toHaveLength(1);
  const read = await h.blobStore.get(restored.rows[0].blob_key);
  const chunks: Buffer[] = [];
  for await (const chunk of read.body) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks)).toEqual(bytes);

  await expectStatus(
    await h.call(`/api/v1/host/communities/${communityId}`, { method: 'DELETE', bearer: key }),
    202,
    'abandon'
  );
  for (let round = 0; round < 5; round++) {
    await h.pool.query(
      'UPDATE community_imports SET next_attempt_at=now() WHERE settled_at IS NULL'
    );
    await drainCleanup(h);
    if (!(await sweepImports(h.pool, h.blobStore, h.config.limits)).claimed) break;
  }
  expect(new Set(await objectNames())).toEqual(before);
});
