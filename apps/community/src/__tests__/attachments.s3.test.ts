import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { unzipSync, strFromU8 } from 'fflate';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { createBlobStore } from '../storage/index.js';
import { bootstrapFirstHost } from './bootstrap-test-helper.js';

const pgUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
const endpoint = process.env.COMMUNITY_TEST_S3_ENDPOINT;
const accessKeyId = process.env.COMMUNITY_TEST_S3_ACCESS_KEY;
const secretAccessKey = process.env.COMMUNITY_TEST_S3_SECRET_KEY;
if (!pgUrl || !endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error(
    'Real Postgres and disposable S3 settings are required for community S3 route tests'
  );
}
const admin = new Pool({ connectionString: pgUrl });
const dbName = `community_s3_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(pgUrl);
dbUrl.pathname = `/${dbName}`;
const bucket = `community-routes-${randomUUID()}`;
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
const config = parseConfig({
  COMMUNITY_DATABASE_URL: dbUrl.toString(),
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_DRIVER: 's3',
  COMMUNITY_S3_BUCKET: bucket,
  COMMUNITY_S3_REGION: 'us-east-1',
  COMMUNITY_S3_ENDPOINT: endpoint,
  COMMUNITY_S3_ACCESS_KEY_ID: accessKeyId,
  COMMUNITY_S3_SECRET_ACCESS_KEY: secretAccessKey,
});
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}
function post(path: string, body: unknown, cookie: string) {
  return request(path, {
    method: 'POST',
    headers: { cookie, origin: config.publicUrl, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeAll(async () => {
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  server = serve({
    fetch: createCommunityApp({ config, pool, blobStore: createBlobStore(config) }).fetch,
    port: 0,
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP address');
  baseUrl = `http://localhost:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  for (const item of objects.Contents ?? []) {
    if (item.Key) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }));
  }
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  s3.destroy();
});

it('uploads, binds, downloads and exports through real MinIO HTTP storage', async () => {
  const setup = await bootstrapFirstHost(post, {
    secret: config.bootstrapSecret,
    accountName: 'Owner',
    email: 'minio-owner@example.test',
    password: 'password1234',
    communityName: 'MinIO',
  });
  const cookie = setup.cookie;
  const channel = await post('/api/v1/channels', { name: 'Files' }, cookie);
  expect(channel.status).toBe(201);
  const channelId = (await channel.json()).channel.id;
  const upload = await request(`/api/v1/channels/${channelId}/attachments`, {
    method: 'POST',
    headers: {
      cookie,
      origin: config.publicUrl,
      'content-type': 'text/plain',
      'idempotency-key': 'minio-file',
      'x-file-name': 'minio.txt',
      'x-file-size': '11',
    },
    body: 'hello minio',
  });
  expect(upload.status).toBe(201);
  const file = (await upload.json()).attachment;
  const bound = await post(
    `/api/v1/channels/${channelId}/entries`,
    { text: 'MinIO file', idempotencyKey: 'minio-post', attachmentIds: [file.id] },
    cookie
  );
  expect(bound.status).toBe(201);
  expect((await bound.json()).entry.attachments).toEqual([file]);
  const download = await request(`/api/v1/attachments/${file.id}`, { headers: { cookie } });
  expect(download.status).toBe(200);
  expect(await download.text()).toBe('hello minio');
  const archive = await post('/api/v1/me/export', {}, cookie);
  expect(archive.status).toBe(201);
  const archiveId = (await archive.json()).archiveId;
  const zipDownload = await request(`/api/v1/exports/${archiveId}`, { headers: { cookie } });
  expect(zipDownload.status).toBe(200);
  const zip = unzipSync(new Uint8Array(await zipDownload.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  expect(manifest.attachments[0].id).toBe(file.id);
  expect(strFromU8(zip[`attachments/${file.id}`])).toBe('hello minio');
});
