import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { strFromU8, unzipSync } from 'fflate';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { migrate } from '../migrate.js';
import { FileSystemBlobStore, type BlobStore } from '../storage/index.js';
import { bootstrapFirstHost } from './bootstrap-test-helper.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for administration tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_administration_http_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
let server: ReturnType<typeof serve>;
let pool: Pool;
let blobStore: BlobStore;
let baseUrl = '';
let storagePath = '';
let ownerCookie = '';
let memberCookie = '';
let ownerMemberId = '';
let communityId = '';
let settingsVersion = 1;
let lifecycleVersion = 1;
const password = 'password1234';
let beforeExportStored: (() => Promise<void>) | undefined;
let afterExportStored: (() => Promise<void>) | undefined;

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
  const filesystem = new FileSystemBlobStore(storagePath);
  blobStore = {
    put: async (input) => {
      if (input.kind === 'export') await beforeExportStored?.();
      const result = await filesystem.put(input);
      if (input.kind === 'export') await afterExportStored?.();
      return result;
    },
    get: (key, options) => filesystem.get(key, options),
    delete: (key, options) => filesystem.delete(key, options),
    listNamespace: (options) => filesystem.listNamespace(options),
  };
  const app = createCommunityApp({ config, pool, blobStore });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;

  const setup = await bootstrapFirstHost(
    (path, body, cookie) => jsonRequest(path, 'POST', body, cookie ?? ''),
    {
      secret: config.bootstrapSecret,
      accountName: 'Owner',
      email: 'admin-owner@example.test',
      password,
      communityName: 'First Community',
    }
  );
  ownerCookie = setup.cookie;
  communityId = setup.communityId;
  ownerMemberId = setup.memberId;
  const invitation = await jsonRequest(`/api/v1/communities/${communityId}/invites`, 'POST', {
    seats: 1,
  });
  expect(invitation.status).toBe(201);
  const { token } = await invitation.json();
  const admitted = await jsonRequest(
    `/api/v1/communities/${communityId}/invites/preflight`,
    'POST',
    { token },
    ''
  );
  expect(admitted.status).toBe(200);
  const grant = cookieOf(admitted);
  const memberSignup = await jsonRequest(
    '/api/auth/sign-up/email',
    'POST',
    {
      name: 'Member',
      email: 'admin-member@example.test',
      password,
    },
    grant
  );
  expect(memberSignup.status).toBe(200);
  memberCookie = `${grant}; ${cookieOf(memberSignup)}`;
  expect(
    (await jsonRequest(`/api/v1/communities/${communityId}/invites/bind`, 'POST', {}, memberCookie))
      .status
  ).toBe(200);
  expect(
    (
      await jsonRequest(
        `/api/v1/communities/${communityId}/invites/redeem`,
        'POST',
        {},
        memberCookie
      )
    ).status
  ).toBe(200);

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
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (storagePath) await rm(storagePath, { recursive: true, force: true });
});

it('rejects suspended public discovery on qualified and singleton routes', async () => {
  const path = `/api/v1/host/communities/${communityId}/lifecycle`;
  const suspended = await jsonRequest(path, 'PATCH', { action: 'suspend', lifecycleVersion });
  expect(suspended.status).toBe(200);
  lifecycleVersion = (await suspended.json()).lifecycleVersion;
  try {
    for (const route of ['/api/v1/community', `/api/v1/communities/${communityId}/community`]) {
      const response = await request(route);
      expect(response.status, route).toBe(503);
      expect(await response.json()).toEqual({
        code: 'COMMUNITY_SUSPENDED',
        message: 'This community is suspended.',
      });
    }
    expect(
      (await request('/api/v1/memberships', { headers: { cookie: ownerCookie } })).status
    ).toBe(200);
  } finally {
    const resumed = await jsonRequest(path, 'PATCH', { action: 'resume', lifecycleVersion });
    expect(resumed.status).toBe(200);
    lifecycleVersion = (await resumed.json()).lifecycleVersion;
  }
});

it('rejects deletion maintenance before a non-owner can reconcile storage', async () => {
  const path = `/api/v1/communities/${communityId}/owner/deletion`;
  const requestBody = {
    lifecycleVersion,
    password,
    confirmName: 'First Community',
    confirmIdSuffix: communityId.slice(-8),
  };
  const reconciliationBefore = (
    await pool.query(
      'SELECT generation,state,namespace_digest FROM tenant_reconciliation WHERE singleton=true'
    )
  ).rows[0];
  const unauthorizedList = vi.spyOn(blobStore, 'listNamespace');
  const unauthorized = await jsonRequest(path, 'POST', requestBody, memberCookie);
  expect(unauthorized.status).toBe(403);
  expect(unauthorizedList).not.toHaveBeenCalled();
  expect(
    (
      await pool.query(
        'SELECT generation,state,namespace_digest FROM tenant_reconciliation WHERE singleton=true'
      )
    ).rows[0]
  ).toEqual(reconciliationBefore);
  unauthorizedList.mockRestore();
});

it('returns an in-flight singleton deletion job before reconciling missing bytes', async () => {
  const path = `/api/v1/communities/${communityId}/owner/deletion`;
  const requestBody = {
    lifecycleVersion,
    password,
    confirmName: 'First Community',
    confirmIdSuffix: communityId.slice(-8),
  };
  const exportResponse = await jsonRequest(
    `/api/v1/communities/${communityId}/owner/export`,
    'POST',
    { password }
  );
  expect(exportResponse.status).toBe(201);
  const { archiveId } = await exportResponse.json();
  const referencedBlobKey = (
    await pool.query<{ blob_key: string }>('SELECT blob_key FROM export_archives WHERE id=$1', [
      archiveId,
    ])
  ).rows[0].blob_key;
  const referencedBytes = await readFile(join(storagePath, referencedBlobKey));

  const requested = await jsonRequest(path, 'POST', requestBody);
  expect(requested.status).toBe(200);
  const first = await requested.json();
  lifecycleVersion = first.lifecycleVersion;
  await blobStore.delete(referencedBlobKey);

  const retryList = vi.spyOn(blobStore, 'listNamespace');
  const retry = await jsonRequest(path, 'POST', { ...requestBody, lifecycleVersion });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(first);
  expect(retryList).not.toHaveBeenCalled();
  retryList.mockRestore();
  await writeFile(join(storagePath, referencedBlobKey), referencedBytes, { mode: 0o600 });

  const cancel = await jsonRequest(`${path}/cancel`, 'POST', { lifecycleVersion, password });
  expect(cancel.status).toBe(200);
  lifecycleVersion = (await cancel.json()).lifecycleVersion;
  const restore = await jsonRequest(`/api/v1/communities/${communityId}/owner/lifecycle`, 'POST', {
    action: 'restore',
    lifecycleVersion,
    password,
  });
  expect(restore.status).toBe(200);
  lifecycleVersion = (await restore.json()).lifecycleVersion;
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
  for (const etag of ['"1"', 'invalid']) {
    const conflict = await jsonRequest(path, 'PATCH', { description: 'Lost edit' }, ownerCookie, {
      'if-match': etag,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('etag')).toBe(`"${settingsVersion}"`);
    expect(await conflict.json()).toEqual({
      code: 'STATE_CONFLICT',
      message: expect.any(String),
      current: updated,
    });
  }
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
  const uncertain = (
    await pool.query<{ blob_key: string; outcome_uncertain: boolean }>(
      `SELECT m.blob_key,p.last_error_at IS NULL AS outcome_uncertain
       FROM managed_blobs m JOIN pending_blob_deletions p USING(blob_key)
       WHERE m.community_id=$1 AND m.purpose='icon' AND m.byte_size IS NULL`,
      [communityId]
    )
  ).rows;
  expect(uncertain).toEqual([{ blob_key: expect.any(String), outcome_uncertain: true }]);
  await pool.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [uncertain[0].blob_key]);
  await pool.query('DELETE FROM managed_blobs WHERE blob_key=$1', [uncertain[0].blob_key]);
});

it('locks community before membership when committing an owner export', async () => {
  const administrator = await pool.connect();
  const { pid } = (await administrator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
    .rows[0];
  let signalStored!: () => void;
  const stored = new Promise<void>((resolve) => {
    signalStored = resolve;
  });
  afterExportStored = async () => {
    await administrator.query('BEGIN');
    await administrator.query('SELECT id FROM communities WHERE id=$1 FOR UPDATE', [communityId]);
    signalStored();
  };
  const exported = jsonRequest(`/api/v1/communities/${communityId}/owner/export`, 'POST', {
    password,
  });
  try {
    await stored;
    await expect
      .poll(async () => {
        const blocked = await pool.query(
          'SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [pid]
        );
        return blocked.rowCount;
      })
      .toBe(1);
    // A competing administration transaction can still take membership while
    // export waits on lifecycle. The old member-first path fails with 55P03.
    await administrator.query('SELECT id FROM members WHERE id=$1 FOR UPDATE NOWAIT', [
      ownerMemberId,
    ]);
  } finally {
    afterExportStored = undefined;
    await administrator.query('ROLLBACK');
    administrator.release();
  }
  expect((await exported).status).toBe(201);
});

it.each(['active', 'archived'] as const)(
  'exports an owner snapshot with %s lifecycle, versions and only its tenant audit',
  async (lifecycle) => {
    const created = await jsonRequest('/api/v1/host/communities', 'POST', {
      idempotencyKey: `export-${lifecycle}`,
      name: `Export ${lifecycle}`,
      description: null,
      admissionPolicy: 'invite_only',
    });
    expect(created.status).toBe(201);
    const pending = await created.json();
    const preflight = await jsonRequest('/api/v1/owner-claims/preflight', 'POST', {
      token: pending.ownerClaimToken,
    });
    expect(preflight.status).toBe(200);
    const sessionCookie = ownerCookie
      .split('; ')
      .filter((part) => !part.startsWith('community_bootstrap='))
      .join('; ');
    const claim = await jsonRequest(
      '/api/v1/owner-claims/claim',
      'POST',
      {},
      `${sessionCookie}; ${cookieOf(preflight)}`
    );
    expect(claim.status).toBe(200);
    const claimed = await claim.json();
    const exportCommunityId = claimed.community.id;
    if (lifecycle === 'archived') {
      const archived = await jsonRequest(
        `/api/v1/communities/${exportCommunityId}/owner/lifecycle`,
        'POST',
        {
          action: 'archive',
          lifecycleVersion: 2,
          password,
          confirmName: `Export ${lifecycle}`,
        }
      );
      expect(archived.status).toBe(200);
    }
    const exported = await jsonRequest(
      `/api/v1/communities/${exportCommunityId}/owner/export`,
      'POST',
      { password }
    );
    expect(exported.status).toBe(201);
    const { archiveId } = await exported.json();
    const download = await request(
      `/api/v1/communities/${exportCommunityId}/exports/${archiveId}`,
      {
        headers: { cookie: ownerCookie },
      }
    );
    expect(download.status).toBe(200);
    const archive = unzipSync(new Uint8Array(await download.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(archive['manifest.json']));
    expect(manifest.community).toEqual({
      id: exportCommunityId,
      lifecycle,
      lifecycleVersion: lifecycle === 'active' ? 2 : 3,
      settingsVersion: 1,
    });
    expect(manifest.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ community_id: exportCommunityId, action: 'owner_claim.consume' }),
      ])
    );
    expect(
      manifest.auditEvents.every(
        (event: { community_id: string }) => event.community_id === exportCommunityId
      )
    ).toBe(true);
    expect(manifest.members).toHaveLength(1);
    expect(manifest.members[0].id).toBe(claimed.memberId);
  }
);

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
  const archivedAccess = await request(`/api/v1/communities/${communityId}/me/connection-access`, {
    headers: { authorization: `Bearer ${readToken}` },
  });
  expect(archivedAccess.status).toBe(200);
  expect(await archivedAccess.json()).toMatchObject({
    access: {
      state: 'verified',
      effective: { read: true, post: false, enrollAgent: false, stream: false },
      lastKnown: {
        lifecycle: 'archived',
        capabilities: { read: true, post: false, enrollAgent: false, stream: false },
      },
    },
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

  const grantsPath = `/api/v1/communities/${communityId}/me/grants`;
  const listed = await request(grantsPath, { headers: { cookie: ownerCookie } });
  expect(listed.status).toBe(200);
  expect((await listed.json()).grants).toEqual([exchanged.grant]);
  const revoked = await request(`${grantsPath}/${exchanged.grant.id}`, {
    method: 'DELETE',
    headers: { cookie: ownerCookie, origin: 'http://localhost:6481' },
  });
  expect(revoked.status).toBe(204);
  const afterRevoke = await request(`/api/v1/communities/${communityId}/channels`, {
    headers: { authorization: `Bearer ${readToken}` },
  });
  expect(afterRevoke.status).toBe(401);

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
  ).toBe(401);
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
  const memberships = await request('/api/v1/memberships', { headers: { cookie: ownerCookie } });
  expect(memberships.status).toBe(200);
  expect((await memberships.json()).memberships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ communityId, lifecycle: 'deletion_pending' }),
    ])
  );
  expect((await request(path, { headers: { cookie: memberCookie } })).status).toBe(403);
  expect(
    (await jsonRequest(`${path}/cancel`, 'POST', { lifecycleVersion, password }, memberCookie))
      .status
  ).toBe(403);
  const recovered = await request(path, { headers: { cookie: ownerCookie } });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual(first);
  expect((await request(path)).status).toBe(401);
  for (const resource of ['me', 'agents', 'icon', 'settings', 'community']) {
    const denied = await request(`/api/v1/communities/${communityId}/${resource}`, {
      headers: { cookie: ownerCookie },
    });
    expect(denied.status, resource).toBe(423);
    expect(await denied.json()).toMatchObject({ code: 'COMMUNITY_DELETION_PENDING' });
  }
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
  let signalExportStarted!: () => void;
  let releaseExport!: () => void;
  const exportStarted = new Promise<void>((resolve) => {
    signalExportStarted = resolve;
  });
  const exportReleased = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  beforeExportStored = async () => {
    signalExportStarted();
    await exportReleased;
  };
  const heldExport = jsonRequest(`/api/v1/communities/${communityId}/owner/export`, 'POST', {
    password,
  });
  await exportStarted;
  const heldBlob = (
    await pool.query<{ blob_key: string }>(
      `SELECT blob_key FROM managed_blobs
       WHERE community_id=$1 AND purpose='export' AND state='reserved'
       ORDER BY created_at DESC LIMIT 1`,
      [communityId]
    )
  ).rows[0];
  expect(heldBlob).toEqual({ blob_key: expect.any(String) });
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
  const heldResult = await sweepCommunityDeletions(pool, blobStore, 100);
  const heldProgress = (
    await pool.query(
      `SELECT p.state,m.state AS managed_state
       FROM community_deletion_blob_progress p
       JOIN managed_blobs m USING(blob_key)
       WHERE p.community_id=$1 AND p.blob_key=$2`,
      [communityId, heldBlob.blob_key]
    )
  ).rows[0];
  const communityRetained = (
    await pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId])
  ).rowCount;
  await pool.query(
    `UPDATE community_deletion_blob_progress SET state='deleted',deleted_at=now()
     WHERE community_id=$1 AND blob_key=$2`,
    [communityId, heldBlob.blob_key]
  );
  await pool.query(
    'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
    [communityId]
  );
  const legacyProgressResult = await sweepCommunityDeletions(pool, blobStore, 100);
  const legacyCommunityRetained = (
    await pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId])
  ).rowCount;

  beforeExportStored = undefined;
  releaseExport();
  expect((await heldExport).status).toBe(409);
  expect((await blobStore.listNamespace()).keys).not.toContain(heldBlob.blob_key);
  expect(heldResult).toMatchObject({ claimed: 1, completed: 0, failed: 0 });
  expect(legacyProgressResult).toMatchObject({ claimed: 1, completed: 0, failed: 0 });
  expect(heldProgress).toEqual({ state: 'retrying', managed_state: 'reserved' });
  expect(communityRetained).toBe(1);
  expect(legacyCommunityRetained).toBe(1);

  await pool.query(
    'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
    [communityId]
  );
  await pool.query(
    `UPDATE community_deletion_blob_progress
     SET state='retrying',deleted_at=NULL,next_attempt_at=now() WHERE community_id=$1`,
    [communityId]
  );
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
