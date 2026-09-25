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
import { sweepCommunityDeletions, sweepCommunityDeletionTombstones } from '../deletion-worker.js';
import { migrate } from '../migrate.js';
import { hashSecret, randomToken, signValue } from '../security.js';
import { bootstrapFirstHost } from './bootstrap-test-helper.js';
import { FileSystemBlobStore, type BlobStore } from '../storage/index.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for administration tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_administration_http_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
let server: ReturnType<typeof serve>;
let app: ReturnType<typeof createCommunityApp>;
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

/**
 * Every table that carries tenant rows. Pinned so that an empty or partial
 * catalogue read fails loudly instead of making a snapshot vacuously equal;
 * a new tenant table must be added here on purpose.
 */
const TENANT_TABLES = [
  'admission_receipts',
  'agent_channel_members',
  'agent_credentials',
  'agents',
  'attachments',
  'audit_events',
  'bootstrap_grants',
  'channel_members',
  'channels',
  'community_content_versions',
  'community_creation_receipts',
  'community_deletion_blob_progress',
  'community_deletion_jobs',
  'community_deletion_tombstones',
  'community_handles',
  'community_limits',
  'community_short_names',
  'connection_grants',
  'connection_pairings',
  'entries',
  'entry_mentions',
  'entry_redactions',
  'erasure_requests',
  'export_archive_channels',
  'export_archives',
  'host_audit_events',
  'invite_uses',
  'invites',
  'managed_blobs',
  'member_limit_overrides',
  'members',
  'owner_quota_windows',
  'pending_admissions',
  'read_cursors',
  'tenant_reconciliation',
];

async function readTenantTables(): Promise<string[]> {
  const tables = (
    await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='community_id' ORDER BY table_name"
    )
  ).rows.map((row) => row.table_name);
  expect(tables).toEqual(TENANT_TABLES);
  return tables;
}

async function rowsOf(sql: string, params: unknown[]): Promise<unknown> {
  return (
    await pool.query(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM (${sql}) t`,
      params
    )
  ).rows[0].rows;
}

/** Tenant rows, community rows, accounts and sessions for the given communities. */
async function isolationSnapshot(communityIds: string[]): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const table of await readTenantTables()) {
    // Table identifiers come exclusively from the pinned catalogue above.
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    result[table] = await rowsOf(`SELECT * FROM ${quoted} WHERE community_id=ANY($1::uuid[])`, [
      communityIds,
    ]);
  }
  // Authenticating with a grant records when it was last used, by design.
  result.connection_grants = (result.connection_grants as Record<string, unknown>[]).map(
    ({ last_used_at: _lastUsed, ...grant }) => grant
  );
  result.communities = await rowsOf('SELECT * FROM communities WHERE id=ANY($1::uuid[])', [
    communityIds,
  ]);
  result.users = await rowsOf('SELECT * FROM "user"', []);
  result.sessions = await rowsOf('SELECT * FROM session', []);
  return result;
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
  app = createCommunityApp({ config, pool, blobStore });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;

  const setup = await bootstrapFirstHost(
    (path, body, cookie) => jsonRequest(path, 'POST', body, cookie),
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

it('rejects foreign objects on every id-taking community route, even for an owner of both', async () => {
  const otherId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM communities WHERE id<>$1 AND lifecycle='active' ORDER BY id LIMIT 1",
      [communityId]
    )
  ).rows[0].id;
  const own = `/api/v1/communities/${communityId}`;
  const other = `/api/v1/communities/${otherId}`;

  // Community B's objects, each created through B's own URL.
  const created = await jsonRequest(`${other}/channels`, 'POST', {
    name: 'Tenant isolation private',
    visibility: 'private',
  });
  expect(created.status).toBe(201);
  const channel = (await created.json()).channel.id;
  // A private channel refuses a non-member with the same 404 as a missing one,
  // so it would hide a missing tenant check. Every channel probe also runs
  // against this public one, which a non-member of B could otherwise read.
  // Two routes gain nothing from it: GET /channels/:id/read-cursor and
  // GET /channels/:id/events answer 404 to any non-member, public or not
  // (liveChannel in routes/events.ts). What keeps them in their tenant is that
  // membership rows carry tenant foreign keys, so no member of A can ever be a
  // member of a channel in B.
  const createdPublic = await jsonRequest(`${other}/channels`, 'POST', {
    name: 'Tenant isolation public',
    visibility: 'public',
  });
  expect(createdPublic.status).toBe(201);
  const publicChannel = (await createdPublic.json()).channel.id;
  const posted = await jsonRequest(`${other}/channels/${channel}/entries`, 'POST', {
    text: 'Only in the other tenant',
    idempotencyKey: 'isolation-positive-entry',
  });
  expect(posted.status).toBe(201);
  const entry = (await posted.json()).entry.id;
  const otherOwner = (
    await pool.query<{ id: string }>(
      "SELECT id FROM members WHERE community_id=$1 AND role='owner'",
      [otherId]
    )
  ).rows[0].id;
  // A non-owner target: owners can never be demoted or become successors, so
  // probes aimed at the owner would be refused even without a tenant check.
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
    'isolation-other-member',
    'Other Member',
    'other-member@isolation.test',
  ]);
  const otherPlainMember = (
    await pool.query<{ id: string }>(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       VALUES($1,'isolation-other-member','Other Member','other-member','member') RETURNING id`,
      [otherId]
    )
  ).rows[0].id;
  const archive = (
    await pool.query<{ id: string }>(
      'SELECT id FROM export_archives WHERE community_id=$1 LIMIT 1',
      [otherId]
    )
  ).rows[0].id;
  const upload = await request(`${other}/channels/${channel}/attachments`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin: 'http://localhost:6481',
      'content-type': 'text/plain',
      'x-file-name': 'isolation.txt',
      'x-file-size': '5',
      'idempotency-key': 'isolation-file',
    },
    body: 'proof',
  });
  expect(upload.status).toBe(201);
  const attachment = (await upload.json()).attachment.id;
  expect(
    (
      await jsonRequest(`${other}/channels/${channel}/entries`, 'POST', {
        text: 'Committed private file',
        idempotencyKey: 'isolation-file-entry',
        attachmentIds: [attachment],
      })
    ).status
  ).toBe(201);
  const invitation = await jsonRequest(`${other}/invites`, 'POST', {
    channelId: channel,
    seats: 1,
  });
  expect(invitation.status).toBe(201);
  const invitationBody = await invitation.json();
  // A join attempt started in B: its admission cookie is the object that
  // binding and redeeming look up.
  const admitted = await jsonRequest(
    `${other}/invites/preflight`,
    'POST',
    { token: invitationBody.token },
    ''
  );
  expect(admitted.status).toBe(200);
  const foreignAdmission = cookieOf(admitted);
  expect(foreignAdmission).toMatch(/^community_admission=/);
  const verifier = randomBytes(32).toString('base64url');
  const pairing = await jsonRequest(`${other}/pairings/start`, 'POST', {
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    installName: 'Isolation fixture',
    scopes: ['read'],
  });
  expect(pairing.status).toBe(201);
  const pairingId = (await pairing.json()).pairingId;
  // Connection grants are minted directly: the pairing handshake that issues
  // them is covered elsewhere, and only the stored grant matters here.
  const otherGrantToken = randomBytes(32).toString('base64url');
  const otherGrant = (
    await pool.query<{ id: string }>(
      `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
       VALUES($1,$2,$3,$4,'Isolation B') RETURNING id`,
      [otherId, otherOwner, hashSecret(otherGrantToken), ['read', 'post', 'enroll-agent']]
    )
  ).rows[0].id;
  const ownGrantToken = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
     VALUES($1,$2,$3,$4,'Isolation A')`,
    [communityId, ownerMemberId, hashSecret(ownGrantToken), ['read', 'post', 'enroll-agent']]
  );
  const enrolled = await request(`${other}/agents`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${otherGrantToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ localAgentId: 'isolation-agent', displayName: 'Isolation Agent' }),
  });
  expect(enrolled.status).toBe(201);
  const agent = (await enrolled.json()).agent.memberId;
  const joinedAgent = await jsonRequest(`${other}/channels/${channel}/agents`, 'POST', {
    agentId: agent,
  });
  expect(joinedAgent.status, await joinedAgent.clone().text()).toBe(200);
  // Community A's own public channel, for probes that pair it with a foreign id.
  const home = await jsonRequest(`${own}/channels`, 'POST', {
    name: 'Isolation home',
    visibility: 'public',
  });
  expect(home.status).toBe(201);
  const ownChannel = (await home.json()).channel.id;

  // Positive controls: each object really exists and is reachable in its own tenant.
  for (const path of [
    `/attachments/${attachment}`,
    `/pairings/${pairingId}`,
    `/channels/${channel}`,
    `/channels/${channel}/entries`,
    `/channels/${channel}/members`,
    `/channels/${channel}/read-cursor`,
    `/channels/${publicChannel}`,
    `/channels/${publicChannel}/entries`,
    `/channels/${publicChannel}/members`,
    `/channels/${publicChannel}/read-cursor`,
    `/exports/${archive}`,
  ]) {
    const response = await request(`${other}${path}`, { headers: { cookie: ownerCookie } });
    expect(response.status, `positive control ${path}`).toBe(200);
    await response.arrayBuffer();
  }
  const grants = await request(`${other}/me/grants`, { headers: { cookie: ownerCookie } });
  expect((await grants.json()).grants.map((grant: { id: string }) => grant.id)).toContain(
    otherGrant
  );
  const agents = await request(`${other}/agents`, { headers: { cookie: ownerCookie } });
  expect((await agents.json()).agents.map((row: { memberId: string }) => row.memberId)).toContain(
    agent
  );
  const members = await request(`${other}/members`, { headers: { cookie: ownerCookie } });
  expect(JSON.stringify(await members.json())).toContain(otherPlainMember);

  type Ids = {
    channel: string;
    entry: string;
    attachment: string;
    invite: string;
    inviteToken: string;
    member: string;
    pairing: string;
    verifier: string;
    grant: string;
    agent: string;
    localAgentId: string;
    archive: string;
    admission: string;
  };
  const foreign: Ids = {
    channel,
    entry,
    attachment,
    invite: invitationBody.invite.id,
    inviteToken: invitationBody.token,
    member: otherPlainMember,
    pairing: pairingId,
    verifier,
    grant: otherGrant,
    agent,
    localAgentId: 'isolation-agent',
    archive,
    admission: foreignAdmission,
  };
  const foreignPublic: Ids = { ...foreign, channel: publicChannel };
  // The same shapes with ids that exist nowhere: a foreign id must be refused
  // exactly as a nonexistent one is, so the response reveals nothing.
  const missing: Ids = {
    channel: randomUUID(),
    entry: randomUUID(),
    attachment: randomUUID(),
    invite: randomUUID(),
    inviteToken: randomBytes(48).toString('base64url'),
    member: randomUUID(),
    pairing: randomUUID(),
    verifier: randomBytes(32).toString('base64url'),
    grant: randomUUID(),
    agent: randomUUID(),
    localAgentId: 'isolation-agent-missing',
    archive: randomUUID(),
    // Correctly signed, so it reaches the lookup, but matches no join attempt.
    admission: `community_admission=${signValue(randomToken(), 'a'.repeat(32))}`,
  };
  const { lifecycle_version: ownLifecycleVersion } = (
    await pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0];

  type Caller = 'member' | 'grant' | 'local' | 'anonymous';
  type Probe = {
    route: string;
    caller?: Caller;
    call: (
      ids: Ids,
      attempt: string
    ) => { path: string; body?: unknown; upload?: string; cookie?: string };
  };
  // Every community route that takes an object id, in its path or its body.
  const probes: Probe[] = [
    { route: 'GET /attachments/:id', call: (x) => ({ path: `/attachments/${x.attachment}` }) },
    {
      route: 'DELETE /attachments/:attachmentId',
      call: (x) => ({ path: `/attachments/${x.attachment}` }),
    },
    { route: 'DELETE /entries/:entryId', call: (x) => ({ path: `/entries/${x.entry}` }) },
    {
      route: 'POST /channels/:id/attachments',
      call: (x) => ({ path: `/channels/${x.channel}/attachments`, upload: 'proof' }),
    },
    { route: 'GET /channels/:id', call: (x) => ({ path: `/channels/${x.channel}` }) },
    {
      route: 'PATCH /channels/:id',
      call: (x) => ({ path: `/channels/${x.channel}`, body: { name: 'Must not change' } }),
    },
    {
      route: 'POST /channels/:id/join',
      call: (x) => ({ path: `/channels/${x.channel}/join`, body: {} }),
    },
    {
      route: 'POST /channels/:id/leave',
      call: (x) => ({ path: `/channels/${x.channel}/leave`, body: {} }),
    },
    {
      route: 'GET /channels/:id/members',
      call: (x) => ({ path: `/channels/${x.channel}/members` }),
    },
    {
      route: 'POST /channels/:id/members',
      call: (x) => ({ path: `/channels/${x.channel}/members`, body: { memberId: ownerMemberId } }),
    },
    {
      route: 'POST /channels/:id/members',
      call: (x) => ({ path: `/channels/${ownChannel}/members`, body: { memberId: x.member } }),
    },
    {
      route: 'DELETE /channels/:id/members/:memberId',
      call: (x) => ({ path: `/channels/${x.channel}/members/${otherOwner}`, body: {} }),
    },
    {
      route: 'DELETE /channels/:id/members/:memberId',
      call: (x) => ({ path: `/channels/${ownChannel}/members/${x.member}`, body: {} }),
    },
    {
      route: 'PATCH /members/:id/role',
      call: (x) => ({ path: `/members/${x.member}/role`, body: { role: 'admin' } }),
    },
    { route: 'DELETE /members/:id', call: (x) => ({ path: `/members/${x.member}`, body: {} }) },
    {
      route: 'POST /owner/transfer',
      call: (x) => ({
        path: '/owner/transfer',
        body: { successorMemberId: x.member, password, lifecycleVersion: ownLifecycleVersion },
      }),
    },
    {
      route: 'POST /channels/:id/entries',
      call: (x, attempt) => ({
        path: `/channels/${x.channel}/entries`,
        body: { text: 'Must not post', idempotencyKey: `isolation-foreign-entry-${attempt}` },
      }),
    },
    {
      route: 'POST /channels/:id/entries',
      call: (x, attempt) => ({
        path: `/channels/${ownChannel}/entries`,
        body: {
          text: 'Must not reply across tenants',
          parentEntryId: x.entry,
          idempotencyKey: `isolation-foreign-parent-${attempt}`,
        },
      }),
    },
    {
      route: 'POST /channels/:id/entries',
      call: (x, attempt) => ({
        path: `/channels/${ownChannel}/entries`,
        body: {
          text: 'Must not attach across tenants',
          attachmentIds: [x.attachment],
          idempotencyKey: `isolation-foreign-attachment-${attempt}`,
        },
      }),
    },
    {
      route: 'GET /channels/:id/entries',
      call: (x) => ({ path: `/channels/${x.channel}/entries` }),
    },
    {
      route: 'GET /channels/:id/read-cursor',
      call: (x) => ({ path: `/channels/${x.channel}/read-cursor` }),
    },
    {
      route: 'PUT /channels/:id/read-cursor',
      call: (x) => ({ path: `/channels/${x.channel}/read-cursor`, body: { cursor: '1' } }),
    },
    { route: 'GET /channels/:id/events', call: (x) => ({ path: `/channels/${x.channel}/events` }) },
    {
      route: 'GET /channels/:id/threads',
      call: (x) => ({ path: `/channels/${x.channel}/threads?roots=${x.entry}` }),
    },
    {
      route: 'POST /invites',
      call: (x) => ({ path: '/invites', body: { channelId: x.channel, seats: 1 } }),
    },
    { route: 'DELETE /invites/:id', call: (x) => ({ path: `/invites/${x.invite}`, body: {} }) },
    {
      route: 'POST /invites/preview',
      caller: 'anonymous',
      call: (x) => ({ path: '/invites/preview', body: { token: x.inviteToken } }),
    },
    {
      route: 'POST /invites/preflight',
      caller: 'anonymous',
      call: (x) => ({ path: '/invites/preflight', body: { token: x.inviteToken } }),
    },
    {
      route: 'POST /invites/bind',
      call: (x) => ({ path: '/invites/bind', body: {}, cookie: x.admission }),
    },
    {
      route: 'POST /invites/redeem',
      call: (x) => ({ path: '/invites/redeem', body: {}, cookie: x.admission }),
    },
    {
      // B's join attempt read at A's URL must look exactly like no join attempt at all.
      route: 'GET /invites/pending',
      call: (x) => ({ path: '/invites/pending', cookie: x.admission }),
    },
    { route: 'GET /exports/:id', call: (x) => ({ path: `/exports/${x.archive}` }) },
    { route: 'GET /pairings/:id', call: (x) => ({ path: `/pairings/${x.pairing}` }) },
    {
      route: 'POST /pairings/approve',
      call: (x) => ({ path: '/pairings/approve', body: { pairingId: x.pairing } }),
    },
    {
      route: 'POST /pairings/decline',
      call: (x) => ({ path: '/pairings/decline', body: { pairingId: x.pairing } }),
    },
    {
      route: 'POST /pairings/poll',
      caller: 'local',
      call: (x) => ({
        path: '/pairings/poll',
        body: { pairingId: x.pairing, verifier: x.verifier },
      }),
    },
    {
      route: 'POST /pairings/exchange',
      caller: 'local',
      call: (x) => ({
        path: '/pairings/exchange',
        body: { pairingId: x.pairing, verifier: x.verifier, code: 'not-a-code' },
      }),
    },
    {
      route: 'POST /pairings/cancel',
      caller: 'local',
      call: (x) => ({
        path: '/pairings/cancel',
        body: { pairingId: x.pairing, verifier: x.verifier },
      }),
    },
    { route: 'DELETE /me/grants/:id', call: (x) => ({ path: `/me/grants/${x.grant}`, body: {} }) },
    {
      route: 'POST /agents/:id/rotate',
      caller: 'grant',
      call: (x) => ({ path: `/agents/${x.agent}/rotate`, body: {} }),
    },
    {
      route: 'POST /agents/recover',
      caller: 'grant',
      call: (x) => ({
        path: '/agents/recover',
        body: { localAgentId: x.localAgentId, displayName: 'Must not recover' },
      }),
    },
    { route: 'DELETE /agents/:id', call: (x) => ({ path: `/agents/${x.agent}`, body: {} }) },
    {
      route: 'POST /channels/:id/agents',
      call: (x) => ({ path: `/channels/${x.channel}/agents`, body: { agentId: x.agent } }),
    },
    {
      route: 'POST /channels/:id/agents',
      call: (x) => ({ path: `/channels/${ownChannel}/agents`, body: { agentId: x.agent } }),
    },
    {
      route: 'DELETE /channels/:id/agents/:agentId',
      call: (x) => ({ path: `/channels/${x.channel}/agents/${x.agent}`, body: {} }),
    },
    {
      route: 'DELETE /channels/:id/agents/:agentId',
      call: (x) => ({ path: `/channels/${ownChannel}/agents/${x.agent}`, body: {} }),
    },
  ];
  // Routes that take no object id at all: they act only on the caller, the
  // community named in the URL, or an object they create. There is nothing
  // foreign to pass them.
  const exempt: Record<string, string> = {
    'GET /community': 'reads the URL community only',
    'GET /auth-options': 'deployment sign-in options, no object',
    'GET /settings': 'reads the URL community only',
    'PATCH /settings': 'edits the URL community only',
    'PUT /settings/icon': 'edits the URL community only',
    'DELETE /settings/icon': 'edits the URL community only',
    'GET /icon': 'reads the URL community only',
    'POST /owner/lifecycle': 'changes the URL community only',
    'GET /owner/deletion': 'reads the URL community only',
    'POST /owner/deletion': 'changes the URL community only',
    'POST /owner/deletion/cancel': 'changes the URL community only',
    'GET /owner/erasures': 'reads the URL community only',
    'POST /owner/export': 'exports the URL community; takes only a password',
    'POST /me/export': 'exports the caller; no body',
    'GET /me': 'the caller only',
    'POST /me/leave': 'the caller only',
    'DELETE /me/grants': "revokes all of the caller's own grants; takes only a password",
    'GET /me/connection-access': 'the calling grant only',
    'DELETE /me/connection': 'the calling grant revokes itself only',
    'GET /me/host-access': "the calling grant's own account; takes no id",
    'GET /me/grants': "lists the caller's own grants",
    'GET /members': 'lists the URL community',
    'GET /channels': 'lists the URL community',
    'POST /channels': 'creates a new channel; references nothing',
    'GET /attention': "the caller's own unread counts",
    'GET /invites': 'lists the URL community',
    'GET /agents': "lists the caller's own agents",
    'POST /pairings/start': 'creates a new pairing; references nothing',
  };

  const scoped = '/api/v1/communities/:communityId';
  const registered = [
    ...new Set(
      app.routes
        .filter((route) => route.method !== 'ALL' && route.path.startsWith(`${scoped}/`))
        .map((route) => `${route.method} ${route.path.slice(scoped.length)}`)
    ),
  ].sort();
  expect(registered.length).toBeGreaterThan(50);
  // Routes whose foreign-id call legitimately succeeds, so they cannot share
  // the refusal comparison; each has its own check after the matrix.
  const separately = ['POST /agents'];
  const probed = new Set(probes.map((probe) => probe.route));
  expect([...probed].filter((route) => route in exempt || separately.includes(route))).toEqual([]);
  expect(separately.filter((route) => route in exempt)).toEqual([]);
  expect([...new Set([...probed, ...Object.keys(exempt), ...separately])].sort()).toEqual(
    registered
  );

  async function send(probe: Probe, ids: Ids, attempt: string) {
    const [method] = probe.route.split(' ');
    const { path, body, upload, cookie } = probe.call(ids, attempt);
    const caller = probe.caller ?? 'member';
    const headers: Record<string, string> = {};
    if (caller === 'member') headers.cookie = cookie ? `${ownerCookie}; ${cookie}` : ownerCookie;
    if (caller === 'grant') headers.authorization = `Bearer ${ownGrantToken}`;
    if (caller !== 'local') headers.origin = 'http://localhost:6481';
    if (upload !== undefined) {
      Object.assign(headers, {
        'content-type': 'text/plain',
        'x-file-name': 'foreign.txt',
        'x-file-size': String(Buffer.byteLength(upload)),
        'idempotency-key': `isolation-foreign-upload-${attempt}`,
      });
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await request(`${own}${path}`, {
      method,
      headers,
      body: upload ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.text() };
  }

  // A probe reads the channel id exactly when swapping it changes the call.
  const variants = probes.flatMap((probe, index) => {
    const label = `${probe.route} #${index}`;
    const readsChannel =
      JSON.stringify(probe.call(foreign, 'shape')) !==
      JSON.stringify(probe.call(foreignPublic, 'shape'));
    return [
      { probe, label, ids: foreign, attempt: `foreign-${index}` },
      ...(readsChannel
        ? [
            {
              probe,
              label: `${label} (public channel)`,
              ids: foreignPublic,
              attempt: `foreign-public-${index}`,
            },
          ]
        : []),
    ];
  });
  // The number of probes that take the channel id. Update it when you add or
  // remove a channel probe; it stops the public run from silently shrinking.
  expect(variants.filter(({ ids }) => ids === foreignPublic)).toHaveLength(17);

  const before = await isolationSnapshot([communityId, otherId]);
  let executed = 0;
  for (const { probe, label, ids, attempt } of variants) {
    const refused = await send(probe, ids, attempt);
    const unknown = await send(probe, missing, `missing-${attempt}`);
    expect(refused.status, `${label} must be refused`).toBeGreaterThanOrEqual(400);
    // A malformed, unauthenticated or cross-site probe would be refused before
    // any lookup, and would then match the nonexistent id for the wrong reason.
    expect(refused.status, `${label} must be authenticated`).not.toBe(401);
    expect(refused.body, `${label} must reach the lookup`).not.toContain('The request is invalid.');
    expect(refused.body, `${label} must pass the origin check`).not.toContain(
      'This request came from an untrusted site.'
    );
    expect(refused, `${label} must match a nonexistent id`).toEqual(unknown);
    executed++;
  }
  expect(executed).toBe(variants.length);
  expect(await isolationSnapshot([communityId, otherId])).toEqual(before);

  // POST /agents looks up the caller's existing agent by its local id, then
  // reactivates it and replaces its credentials. A local id that exists only
  // in B must create a fresh agent in A and leave B's agent untouched.
  const checked = new Set<string>();
  const otherBefore = await isolationSnapshot([otherId]);
  const sameLocalId = await request(`${own}/agents`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ownGrantToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      localAgentId: foreign.localAgentId,
      displayName: 'Own agent, same local id',
    }),
  });
  expect(sameLocalId.status, 'POST /agents with a local id used in B').toBe(201);
  const ownAgent = (await sameLocalId.json()).agent.memberId;
  expect(ownAgent).not.toBe(agent);
  expect(
    (await pool.query('SELECT community_id FROM agents WHERE id=$1', [ownAgent])).rows[0]
  ).toEqual({ community_id: communityId });
  expect(await isolationSnapshot([otherId])).toEqual(otherBefore);
  checked.add('POST /agents');
  expect([...checked]).toEqual(separately);
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
    (
      await pool.query(
        'SELECT bool_and(revoked_at IS NOT NULL) AS revoked FROM connection_grants WHERE community_id=$1',
        [communityId]
      )
    ).rows[0]
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
    (
      await pool.query(
        'SELECT bool_and(revoked_at IS NOT NULL) AS revoked FROM connection_grants WHERE community_id=$1',
        [communityId]
      )
    ).rows[0]
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
  // Keep a populated, active tenant and an already-open stream alive while the
  // other tenant is deleted, including provider failure and worker restart.
  const survivorId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM communities WHERE id<>$1 AND lifecycle='active' ORDER BY id LIMIT 1",
      [communityId]
    )
  ).rows[0].id;
  const survivorPath = `/api/v1/communities/${survivorId}`;
  const channelResponse = await jsonRequest(`${survivorPath}/channels`, 'POST', {
    name: 'Surviving private history',
    visibility: 'private',
  });
  expect(channelResponse.status).toBe(201);
  const survivorChannel = (await channelResponse.json()).channel.id;
  const bytes = 'Private surviving tenant file';
  const uploaded = await request(`${survivorPath}/channels/${survivorChannel}/attachments`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin: 'http://localhost:6481',
      'content-type': 'text/plain',
      'x-file-name': 'survivor.txt',
      'x-file-size': String(Buffer.byteLength(bytes)),
      'idempotency-key': 'survivor-upload',
    },
    body: bytes,
  });
  expect(uploaded.status).toBe(201);
  const survivorAttachment = (await uploaded.json()).attachment.id;
  expect(
    (
      await jsonRequest(`${survivorPath}/channels/${survivorChannel}/entries`, 'POST', {
        text: 'Keep this private history',
        idempotencyKey: 'survivor-entry',
        attachmentIds: [survivorAttachment],
      })
    ).status
  ).toBe(201);
  // Its tenant rows, its community row, and every account and session.
  const survivorManifest = () => isolationSnapshot([survivorId]);
  const survivorBefore = await survivorManifest();
  const streamAbort = new AbortController();
  const stream = await request(`${survivorPath}/channels/${survivorChannel}/events`, {
    headers: { cookie: ownerCookie },
    signal: streamAbort.signal,
  });
  expect(stream.status).toBe(200);
  const streamReader = stream.body!.getReader();
  let streamBuffer = '';
  async function nextFrame() {
    while (true) {
      const boundary = streamBuffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = streamBuffer.slice(0, boundary);
        streamBuffer = streamBuffer.slice(boundary + 2);
        if (frame.includes('event:')) return frame;
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        streamReader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Surviving tenant stream did not deliver')),
            5000
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (part.done) throw new Error('Deleting another tenant closed the surviving stream');
      streamBuffer += new TextDecoder().decode(part.value);
    }
  }
  try {
    expect(await nextFrame()).toContain('event: snapshot');
    expect(await nextFrame()).toContain('event: replay_complete');

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
    const requested = await jsonRequest(
      `/api/v1/communities/${communityId}/owner/deletion`,
      'POST',
      {
        lifecycleVersion,
        password,
        confirmName: 'Renamed Community',
        confirmIdSuffix: communityId.slice(-8),
      }
    );
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
    expect(
      (await pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId])).rowCount
    ).toBe(0);
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
      'requested_by',
      'requested_by_host_actor',
      'retry_count',
    ]);
    expect(tombstone.requested_by).toBe('owner');
    expect(tombstone.requested_by_host_actor).toBeNull();
    expect(await sweepCommunityDeletionTombstones(pool)).toBe(0);
    await pool.query(
      "UPDATE community_deletion_tombstones SET requested_at=now()-interval '32 days', completed_at=now()-interval '31 days', expires_at=now()-interval '1 day' WHERE community_id=$1",
      [communityId]
    );
    expect(await sweepCommunityDeletionTombstones(pool)).toBe(1);
    expect(
      (
        await pool.query('SELECT 1 FROM community_deletion_tombstones WHERE community_id=$1', [
          communityId,
        ])
      ).rowCount
    ).toBe(0);
    expect(await survivorManifest()).toEqual(survivorBefore);
    expect((await request(`${survivorPath}/me`, { headers: { cookie: ownerCookie } })).status).toBe(
      200
    );
    const download = await request(`${survivorPath}/attachments/${survivorAttachment}`, {
      headers: { cookie: ownerCookie },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(bytes);
    const afterDeletion = await jsonRequest(
      `${survivorPath}/channels/${survivorChannel}/entries`,
      'POST',
      {
        text: 'Still connected after another tenant was deleted',
        idempotencyKey: 'survivor-after-deletion',
      }
    );
    expect(afterDeletion.status).toBe(201);
    const confirmedId = (await afterDeletion.json()).entry.id;
    const delivered = await nextFrame();
    expect(delivered).toContain('event: entry');
    expect(delivered).toContain(confirmedId);
  } finally {
    streamAbort.abort();
    await streamReader.cancel().catch(() => undefined);
  }
});
