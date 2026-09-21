import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { migrate } from '../migrate.js';
import { FileSystemBlobStore, type BlobStore } from '../storage/index.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for administration tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_administration_http_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
let server: ReturnType<typeof serve>;
let pool: Pool;
let baseUrl = '';
let storagePath = '';
let ownerCookie = '';
let ownerMemberId = '';
let communityId = '';
let settingsVersion = 1;
let lifecycleVersion = 1;
const password = 'password1234';

function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, options);
}

async function jsonRequest(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  cookie = ownerCookie,
  headers: Record<string, string> = {}
): Promise<Response> {
  return request(path, {
    method,
    headers: {
      cookie,
      origin: 'http://localhost:6481',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'community-admin-blobs-'));
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
    COMMUNITY_STORAGE_PATH: storagePath,
  });
  const app = createCommunityApp({ config, pool });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;

  const preflight = await jsonRequest(
    '/api/v1/bootstrap/preflight',
    'POST',
    { secret: config.bootstrapSecret },
    ''
  );
  const bootstrapCookie = cookieOf(preflight);
  const signup = await jsonRequest(
    '/api/auth/sign-up/email',
    'POST',
    { name: 'Owner', email: 'admin-owner@example.test', password },
    bootstrapCookie
  );
  ownerCookie = `${bootstrapCookie}; ${cookieOf(signup)}`;
  const claim = await jsonRequest(
    '/api/v1/bootstrap/claim',
    'POST',
    { secret: config.bootstrapSecret, name: 'First Community' },
    ownerCookie
  );
  const claimed = await claim.json();
  communityId = claimed.community.id;
  ownerMemberId = claimed.memberId;
  const current = (
    await pool.query('SELECT settings_version,lifecycle_version FROM communities WHERE id=$1', [
      communityId,
    ])
  ).rows[0];
  settingsVersion = current.settings_version;
  lifecycleVersion = current.lifecycle_version;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  if (storagePath) await rm(storagePath, { recursive: true, force: true });
});

it('creates a pending tenant idempotently and rotates its private owner claim', async () => {
  const body = {
    idempotencyKey: 'create-second',
    name: 'Second Community',
    description: null,
    admissionPolicy: 'invite_only',
  };
  const created = await jsonRequest('/api/v1/host/communities', 'POST', body);
  expect(created.status).toBe(201);
  expect(created.headers.get('cache-control')).toBe('no-store');
  const first = await created.json();
  expect(first.ownerClaimToken).toEqual(expect.any(String));
  expect(first.replayed).toBe(false);
  expect(first.community).toMatchObject({ lifecycle: 'pending_owner', ownerPresent: false });

  const replay = await jsonRequest('/api/v1/host/communities', 'POST', body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    ownerClaimGrantId: first.ownerClaimGrantId,
    ownerClaimToken: null,
    replayed: true,
  });
  expect(
    (
      await jsonRequest('/api/v1/host/communities', 'POST', {
        ...body,
        name: 'Changed',
      })
    ).status
  ).toBe(409);

  const replacement = await jsonRequest(
    `/api/v1/host/communities/${first.community.id}/owner-claims/reissue`,
    'POST',
    {}
  );
  expect(replacement.status).toBe(200);
  const replacementBody = await replacement.json();
  expect(replacementBody.ownerClaimToken).toEqual(expect.any(String));
  expect(replacementBody.grantId).not.toBe(first.ownerClaimGrantId);
  expect(
    (
      await pool.query(
        `SELECT count(*)::int AS count FROM bootstrap_grants
         WHERE community_id=$1 AND purpose='owner_claim' AND revoked_at IS NULL`,
        [first.community.id]
      )
    ).rows[0].count
  ).toBe(1);
});

it('uses settings ETags and keeps admin fields out of canonical addressing', async () => {
  const path = `/api/v1/communities/${communityId}/settings`;
  const current = await request(path, { headers: { cookie: ownerCookie } });
  expect(current.status).toBe(200);
  expect(current.headers.get('etag')).toBe(`"${settingsVersion}"`);
  const update = await jsonRequest(
    path,
    'PATCH',
    { name: 'Renamed Community', description: 'Private team space', admissionPolicy: 'closed' },
    ownerCookie,
    { 'if-match': `"${settingsVersion}"` }
  );
  expect(update.status).toBe(200);
  const updated = await update.json();
  settingsVersion = updated.settingsVersion;
  expect(updated).toMatchObject({
    communityId,
    name: 'Renamed Community',
    admissionPolicy: 'closed',
  });
  expect(
    (
      await jsonRequest(path, 'PATCH', { description: 'Lost edit' }, ownerCookie, {
        'if-match': '"1"',
      })
    ).status
  ).toBe(409);
});

it('stores private raster icons with ETags and queues replaced bytes', async () => {
  const path = `/api/v1/communities/${communityId}/settings/icon`;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('icon-one')]);
  const uploaded = await request(path, {
    method: 'PUT',
    headers: { cookie: ownerCookie, 'if-match': `"${settingsVersion}"` },
    body: png,
  });
  expect(uploaded.status).toBe(200);
  const projection = await uploaded.json();
  settingsVersion = projection.settingsVersion;
  expect(projection.hasIcon).toBe(true);
  expect(projection).not.toHaveProperty('iconBlobKey');

  const download = await request(`/api/v1/communities/${communityId}/icon`, {
    headers: { cookie: ownerCookie },
  });
  expect(download.status).toBe(200);
  expect(download.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await download.arrayBuffer())).toEqual(png);

  const firstKey = (
    await pool.query<{ icon_blob_key: string }>(
      'SELECT icon_blob_key FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0].icon_blob_key;
  const jpeg = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.from('icon-two')]);
  const replacement = await request(path, {
    method: 'PUT',
    headers: { cookie: ownerCookie, 'if-match': `"${settingsVersion}"` },
    body: jpeg,
  });
  expect(replacement.status).toBe(200);
  settingsVersion = (await replacement.json()).settingsVersion;
  expect(
    (await pool.query('SELECT state FROM managed_blobs WHERE blob_key=$1', [firstKey])).rows[0]
  ).toEqual({ state: 'pending_delete' });

  const rejected = await request(path, {
    method: 'PUT',
    headers: { cookie: ownerCookie, 'if-match': `"${settingsVersion}"` },
    body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  expect(rejected.status).toBe(415);

  const cleared = await request(path, {
    method: 'DELETE',
    headers: { cookie: ownerCookie, 'if-match': `"${settingsVersion}"` },
  });
  expect(cleared.status).toBe(200);
  const clearedProjection = await cleared.json();
  settingsVersion = clearedProjection.settingsVersion;
  expect(clearedProjection.hasIcon).toBe(false);
  expect(
    (
      await request(`/api/v1/communities/${communityId}/icon`, {
        headers: { cookie: ownerCookie },
      })
    ).status
  ).toBe(404);
});

it('archives with immediate credential revocation and restores without revival', async () => {
  const channel = await jsonRequest(`/api/v1/communities/${communityId}/channels`, 'POST', {
    name: 'Archive history',
  });
  expect(channel.status).toBe(201);
  const channelId = (await channel.json()).channel.id as string;
  const pendingPairingId = randomUUID();
  await pool.query(
    `INSERT INTO connection_grants(community_id,member_id,token_hash,install_name,scopes)
     VALUES($1,$2,'grant-hash','Test install',ARRAY['read','post'])`,
    [communityId, ownerMemberId]
  );
  await pool.query(
    `INSERT INTO connection_pairings(
       id,community_id,verifier_hash,install_name,scopes,expires_at
     ) VALUES($1,$2,'pending-pairing-hash','Pending install',ARRAY['read'],now()+interval '10 minutes')`,
    [pendingPairingId, communityId]
  );
  const archive = await jsonRequest(`/api/v1/communities/${communityId}/owner/lifecycle`, 'POST', {
    action: 'archive',
    lifecycleVersion,
    password,
    confirmName: 'Renamed Community',
  });
  expect(archive.status).toBe(200);
  const archived = await archive.json();
  lifecycleVersion = archived.lifecycleVersion;
  expect(archived.lifecycle).toBe('archived');
  expect(
    (await pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM connection_grants')).rows[0]
  ).toEqual({ revoked: true });
  expect(
    (
      await pool.query(
        'SELECT cancelled_at IS NOT NULL AS cancelled FROM connection_pairings WHERE id=$1',
        [pendingPairingId]
      )
    ).rows[0]
  ).toEqual({ cancelled: true });
  expect(
    (
      await request(`/api/v1/communities/${communityId}/settings`, {
        headers: { cookie: ownerCookie },
      })
    ).status
  ).toBe(200);
  const write = await jsonRequest(`/api/v1/communities/${communityId}/channels`, 'POST', {
    name: 'Blocked',
  });
  expect(write.status).toBe(423);
  expect((await write.json()).code).toBe('COMMUNITY_ARCHIVED');

  const rejectedPairing = await request(`/api/v1/communities/${communityId}/pairings/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installName: 'Writable install',
      challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
      scopes: ['read', 'post'],
    }),
  });
  expect(rejectedPairing.status).toBe(423);

  const verifier = randomBytes(32).toString('base64url');
  const start = await request(`/api/v1/communities/${communityId}/pairings/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installName: 'Archived reader',
      challenge: createHash('sha256').update(verifier).digest('base64url'),
      scopes: ['read'],
    }),
  });
  expect(start.status).toBe(201);
  const pairing = await start.json();
  expect(pairing.approvalUrl).toContain(`/c/${communityId}/pairing`);
  expect(
    (
      await jsonRequest(`/api/v1/communities/${communityId}/pairings/approve`, 'POST', {
        pairingId: pairing.pairingId,
      })
    ).status
  ).toBe(200);
  const poll = await request(`/api/v1/communities/${communityId}/pairings/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingId: pairing.pairingId, verifier }),
  });
  expect(poll.status).toBe(200);
  const code = (await poll.json()).code;
  const exchange = await request(`/api/v1/communities/${communityId}/pairings/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingId: pairing.pairingId, verifier, code }),
  });
  expect(exchange.status).toBe(200);
  const exchanged = await exchange.json();
  const readToken = exchanged.token as string;
  expect(exchanged.grant).toMatchObject({
    lifecycle: 'archived',
    capabilities: { read: true, post: false, enrollAgent: false, stream: false },
  });
  expect(
    (
      await pool.query(
        'SELECT history_only FROM connection_grants WHERE token_hash=$1 AND revoked_at IS NULL',
        [createHash('sha256').update(readToken).digest('hex')]
      )
    ).rows[0]
  ).toEqual({ history_only: true });
  expect(
    (
      await request(`/api/v1/communities/${communityId}/channels`, {
        headers: { authorization: `Bearer ${readToken}` },
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request(`/api/v1/communities/${communityId}/channels`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${readToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Still blocked' }),
      })
    ).status
  ).not.toBe(201);
  expect(
    (
      await request(`/api/v1/communities/${communityId}/channels/${channelId}/events`, {
        headers: { authorization: `Bearer ${readToken}` },
      })
    ).status
  ).toBe(403);

  const restore = await jsonRequest(`/api/v1/communities/${communityId}/owner/lifecycle`, 'POST', {
    action: 'restore',
    lifecycleVersion,
    password,
  });
  expect(restore.status).toBe(200);
  const restored = await restore.json();
  lifecycleVersion = restored.lifecycleVersion;
  expect(restored.lifecycle).toBe('active');
  expect(
    (await pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM connection_grants')).rows[0]
  ).toEqual({ revoked: true });
  expect(
    (
      await request(`/api/v1/communities/${communityId}/channels`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${readToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'No scope widening' }),
      })
    ).status
  ).not.toBe(201);
  expect(
    (
      await request(`/api/v1/communities/${communityId}/channels/${channelId}/events`, {
        headers: { authorization: `Bearer ${readToken}` },
      })
    ).status
  ).toBe(403);
});

it('requests deletion idempotently and cancels back to archived without reviving access', async () => {
  const path = `/api/v1/communities/${communityId}/owner/deletion`;
  const requestBody = {
    lifecycleVersion,
    password,
    confirmName: 'Renamed Community',
    confirmIdSuffix: communityId.slice(-8),
  };
  const requested = await jsonRequest(path, 'POST', requestBody);
  expect(requested.status).toBe(200);
  expect(
    (await sweepCommunityDeletions(pool, new FileSystemBlobStore(storagePath), 1)).claimed
  ).toBe(0);
  const first = await requested.json();
  lifecycleVersion = first.lifecycleVersion;
  expect(first).toMatchObject({ lifecycle: 'deletion_pending', state: 'waiting', attempts: 0 });
  const retry = await jsonRequest(path, 'POST', { ...requestBody, lifecycleVersion });
  expect(retry.status).toBe(200);
  expect((await retry.json()).deleteAfter).toBe(first.deleteAfter);

  const cancel = await jsonRequest(`${path}/cancel`, 'POST', { lifecycleVersion, password });
  expect(cancel.status).toBe(200);
  const cancelled = await cancel.json();
  lifecycleVersion = cancelled.lifecycleVersion;
  expect(cancelled).toMatchObject({ lifecycle: 'archived', deleteAfter: null, state: null });
});

it('deletes only the due tenant after every owned blob is confirmed absent', async () => {
  const other = await pool.query<{ id: string }>(
    "SELECT id FROM communities WHERE id<>$1 AND lifecycle='pending_owner' LIMIT 1",
    [communityId]
  );
  const accountCount = Number(
    (await pool.query('SELECT count(*) AS count FROM "user"')).rows[0].count
  );
  const requested = await jsonRequest(`/api/v1/communities/${communityId}/owner/deletion`, 'POST', {
    lifecycleVersion,
    password,
    confirmName: 'Renamed Community',
    confirmIdSuffix: communityId.slice(-8),
  });
  expect(requested.status).toBe(200);
  await pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [communityId]
  );
  await pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
     WHERE community_id=$1`,
    [communityId]
  );

  const blobStore = new FileSystemBlobStore(storagePath);
  let failNextDelete = true;
  const failingBlobStore: BlobStore = {
    put: (input) => blobStore.put(input),
    get: (key, options) => blobStore.get(key, options),
    listNamespace: (options) => blobStore.listNamespace(options),
    delete: async (key, options) => {
      if (failNextDelete) {
        failNextDelete = false;
        throw new Error('injected provider failure');
      }
      await blobStore.delete(key, options);
    },
  };
  const failed = await sweepCommunityDeletions(pool, failingBlobStore, 1);
  expect(failed).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
  expect(
    (
      await pool.query('SELECT state FROM community_deletion_jobs WHERE community_id=$1', [
        communityId,
      ])
    ).rows[0]
  ).toEqual({ state: 'retrying' });
  await pool.query(
    'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
    [communityId]
  );
  await pool.query(
    'UPDATE community_deletion_blob_progress SET next_attempt_at=now() WHERE community_id=$1',
    [communityId]
  );
  let result = await sweepCommunityDeletions(pool, blobStore, 1);
  for (let index = 0; index < 10 && !result.completed; index++) {
    await pool.query(
      'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
      [communityId]
    );
    result = await sweepCommunityDeletions(pool, blobStore, 1);
  }
  expect(result.completed).toBe(1);
  expect((await pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId])).rowCount).toBe(
    0
  );
  expect(
    (await pool.query('SELECT 1 FROM communities WHERE id=$1', [other.rows[0].id])).rowCount
  ).toBe(1);
  expect(Number((await pool.query('SELECT count(*) AS count FROM "user"')).rows[0].count)).toBe(
    accountCount
  );
  const tombstone = (
    await pool.query('SELECT * FROM community_deletion_tombstones WHERE community_id=$1', [
      communityId,
    ])
  ).rows[0];
  expect(Object.keys(tombstone).sort()).toEqual([
    'community_id',
    'completed_at',
    'expires_at',
    'outcome',
    'requested_at',
    'retry_count',
  ]);
});
