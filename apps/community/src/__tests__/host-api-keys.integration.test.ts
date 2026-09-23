/**
 * Host API keys: the P1 adversarial matrix of `specs/community-host-operator-api`
 * (rows 1-5 and 9-16; rows 6-8 need the limit routes and live with them), plus the
 * acceptance criteria for scopes, storage, rotation, the offline command, and cleanup.
 *
 * A key is host authority for automation. Every test here guards one way that authority could
 * widen: a key reaching community content, a key managing keys, a revoked, expired, or rotated
 * key still working, a scope being ignored, or a secret being stored, logged, or echoed.
 *
 * Tests run in order and share one host, whose clock for key expiry is injected.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { runHostKeyCommand } from '../host-keys.js';
import { hashSecret, mintHostApiKeySecret } from '../security.js';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  expectStatus,
  holdingLock,
  pairInstall,
  preflightOwnerClaim,
  startTenancyHarness,
  waitForLockWaiters,
  type TenancyHarness,
} from './tenancy-test-harness.js';

const ALL_SCOPES = [
  'communities:read',
  'communities:write',
  'communities:lifecycle',
  'communities:import',
];

let h: TenancyHarness;
/** Added to the wall clock by the server's key-expiry clock. */
let clockOffsetMs = 0;
let operatorCookie = '';
let a = '';
let channelA = '';
let memberBearer = '';
let exportId = '';
let attachmentId = '';
const keys: Record<'all' | 'read' | 'revoked' | 'expired', { id: string; secret: string }> = {
  all: { id: '', secret: '' },
  read: { id: '', secret: '' },
  revoked: { id: '', secret: '' },
  expired: { id: '', secret: '' },
};

/** Every response body the tests saw, and whether it was a deliberate one-time secret handoff. */
const bodies: { label: string; text: string; oneTime: boolean }[] = [];
/** Every line the server wrote to the console while the tests ran. */
const logLines: string[] = [];
/** Every secret the tests learned: key secrets, their hashes, and owner-claim tokens. */
const secrets = new Set<string>();

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;

async function call(
  path: string,
  init: Parameters<TenancyHarness['call']>[1] = {},
  oneTime = false
): Promise<Response> {
  const response = await h.call(path, init);
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    bodies.push({ label: path, text: '<stream>', oneTime });
  } else {
    bodies.push({ label: path, text: await response.clone().text(), oneTime });
  }
  return response;
}

async function issueKey(
  scopes: string[],
  expiresInDays: number | null = null,
  label = 'Automation'
): Promise<{ id: string; secret: string }> {
  const response = await expectStatus(
    await call(
      '/api/v1/host/api-keys',
      {
        cookie: operatorCookie,
        body: { label, scopes, expiresInDays, password: TENANCY_PASSWORD },
      },
      true
    ),
    201,
    `issue ${label}`
  );
  const body = await response.json();
  secrets.add(body.secret);
  secrets.add(hashSecret(body.secret));
  return { id: body.key.id, secret: body.secret };
}

async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of [
    'members',
    'connection_grants',
    'agent_credentials',
    'bootstrap_grants',
    'entries',
    'channels',
    'invites',
    'connection_pairings',
    'export_archives',
    'host_audit_events',
    'communities',
  ]) {
    result[table] = (
      await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
    ).rows[0].n;
  }
  return result;
}

async function lifecycleOf(communityId: string) {
  return (
    await h.pool.query<{ lifecycle: string; lifecycle_version: number }>(
      'SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0];
}

async function auditRows(action: string) {
  return (
    await h.pool.query(
      `SELECT actor_kind,actor_user_id,actor_api_key_id,subject_api_key_id,community_id,
              prior_state,next_state,changed_fields
       FROM host_audit_events WHERE action=$1 ORDER BY created_at,id`,
      [action]
    )
  ).rows;
}

beforeAll(async () => {
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
      original(...args);
    });
  }
  h = await startTenancyHarness('host_keys', {
    now: () => new Date(Date.now() + clockOffsetMs),
  });
  const host = await bootstrapHost(h, 'Operator', 'operator@host-keys.test');
  operatorCookie = host.cookie;
  a = host.communityId;
  channelA = host.channelId;
  memberBearer = await pairInstall(h, a, operatorCookie);
  const exported = await expectStatus(
    await call(`${tenant(a)}/owner/export`, {
      cookie: operatorCookie,
      body: { password: TENANCY_PASSWORD },
    }),
    201,
    'owner export'
  );
  exportId = (await exported.json()).archiveId;
  const uploaded = await expectStatus(
    await call(`${tenant(a)}/channels/${channelA}/attachments`, {
      method: 'POST',
      cookie: operatorCookie,
      headers: {
        'content-type': 'text/plain',
        'x-file-name': 'a.txt',
        'x-file-size': '1',
        'idempotency-key': 'a-file',
      },
      raw: 'a',
    }),
    201,
    'upload'
  );
  attachmentId = (await uploaded.json()).attachment.id;
  keys.all = await issueKey(ALL_SCOPES, null, 'Everything');
  keys.read = await issueKey(['communities:read'], null, 'Reader');
  keys.revoked = await issueKey(ALL_SCOPES, null, 'Revoked');
  keys.expired = await issueKey(ALL_SCOPES, 1, 'Short-lived');
  await expectStatus(
    await call(`/api/v1/host/api-keys/${keys.revoked.id}/revoke`, {
      cookie: operatorCookie,
      body: {},
    }),
    200,
    'revoke'
  );
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await h?.close();
});

const contentReads = () => [
  '/channels',
  `/channels/${channelA}`,
  `/channels/${channelA}/entries`,
  `/channels/${channelA}/members`,
  '/members',
  '/invites',
  '/agents',
  `/exports/${exportId}`,
  `/attachments/${attachmentId}`,
  `/channels/${channelA}/events`,
];
const contentWrites = () =>
  [
    ['/invites', { seats: 1 }],
    [
      '/pairings/start',
      { installName: 'Key install', challenge: 'x'.repeat(43), scopes: ['read'] },
    ],
    ['/agents', { name: 'Key agent' }],
    ['/owner/export', { password: TENANCY_PASSWORD }],
    [`/channels/${channelA}/entries`, { text: 'from a key', idempotencyKey: 'key-post' }],
  ] as const;

it('row 2: refuses a key on every content route of the unqualified single-community alias', async () => {
  // Purpose: the alias resolves the only community without naming it; a key must not ride it.
  const before = await counts();
  for (const path of contentReads()) {
    const response = await call(`/api/v1${path}`, { bearer: keys.all.secret });
    expect(response.status, `GET alias ${path}`).toBe(401);
    expect((await response.json()).code).toBe('UNAUTHENTICATED');
  }
  for (const [path, body] of contentWrites()) {
    const response = await call(`/api/v1${path}`, { bearer: keys.all.secret, body });
    expect(response.status, `POST alias ${path}`).toBe(401);
  }
  expect(await counts()).toEqual(before);
});

it('rows 1 and 3: refuses a key on every content read, stream, and write of a named community', async () => {
  // Purpose: fails if any content route accepts a key, opens a stream for it, or writes a row.
  const before = await counts();
  for (const path of contentReads()) {
    const response = await call(`${tenant(a)}${path}`, { bearer: keys.all.secret });
    expect(response.status, `GET ${path}`).toBe(401);
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect((await response.json()).code).toBe('UNAUTHENTICATED');
  }
  for (const [path, body] of contentWrites()) {
    const response = await call(`${tenant(a)}${path}`, { bearer: keys.all.secret, body });
    expect(response.status, `POST ${path}`).toBe(401);
  }
  // A key sent beside the owner's own session cookie still reaches nothing.
  const withCookie = await call(`${tenant(a)}/channels`, {
    bearer: keys.all.secret,
    cookie: operatorCookie,
  });
  expect(withCookie.status).toBe(401);
  expect(await counts()).toEqual(before);
});

it('row 4: a key cannot mint an owner claim into an active community', async () => {
  // Purpose: fails if host write authority can hand out ownership of a claimed community.
  const before = await counts();
  const response = await call(`/api/v1/host/communities/${a}/owner-claims/reissue`, {
    bearer: keys.all.secret,
    body: {},
  });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('STATE_CONFLICT');
  expect(await counts()).toEqual(before);
});

it('rows 5 and 16: a key creates and abandons a pending community, audited as the key, and its claim needs a session', async () => {
  // Purpose: fails if key mutations are audited as a person, carry values, or if a claim token
  // alone (or with the key) can take ownership without a signed-in account.
  const created = await expectStatus(
    await call(
      '/api/v1/host/communities',
      {
        bearer: keys.all.secret,
        body: { idempotencyKey: 'key-create-c', name: 'Community C', description: 'Private words' },
      },
      true
    ),
    201,
    'create C'
  );
  const createdBody = await created.json();
  const c = createdBody.community.id as string;
  secrets.add(createdBody.ownerClaimToken);
  expect(created.headers.get('cache-control')).toBe('no-store');
  expect(
    (
      await h.pool.query(
        'SELECT operator_user_id,operator_api_key_id FROM community_creation_receipts WHERE community_id=$1',
        [c]
      )
    ).rows
  ).toEqual([{ operator_user_id: null, operator_api_key_id: keys.all.id }]);

  const claimCookie = await preflightOwnerClaim(h, createdBody.ownerClaimToken);
  for (const init of [{ cookie: claimCookie }, { cookie: claimCookie, bearer: keys.all.secret }]) {
    const claim = await call('/api/v1/owner-claims/claim', { ...init, body: {} });
    expect(claim.status).toBe(401);
  }
  expect(
    (
      await h.pool.query(
        "SELECT consumed_at FROM bootstrap_grants WHERE community_id=$1 AND purpose='owner_claim'",
        [c]
      )
    ).rows
  ).toEqual([{ consumed_at: null }]);

  const reissued = await expectStatus(
    await call(
      `/api/v1/host/communities/${c}/owner-claims/reissue`,
      { bearer: keys.all.secret, body: {} },
      true
    ),
    200,
    'reissue C'
  );
  const reissue = await reissued.json();
  secrets.add(reissue.ownerClaimToken);
  await expectStatus(
    await call(`/api/v1/host/communities/${c}/owner-claims/${reissue.grantId}/revoke`, {
      bearer: keys.all.secret,
      body: {},
    }),
    204,
    'revoke C claim'
  );
  expect(
    (
      await h.pool.query(
        `SELECT revoked_by,revoked_by_api_key_id FROM bootstrap_grants
         WHERE community_id=$1 ORDER BY created_at`,
        [c]
      )
    ).rows
  ).toEqual([
    { revoked_by: null, revoked_by_api_key_id: keys.all.id },
    { revoked_by: null, revoked_by_api_key_id: keys.all.id },
  ]);
  const single = await expectStatus(
    await call(`/api/v1/host/communities/${c}`, { bearer: keys.read.secret }),
    200,
    'read C'
  );
  expect((await single.json()).lifecycle).toBe('pending_owner');
  await expectStatus(
    await call(`/api/v1/host/communities/${c}`, { method: 'DELETE', bearer: keys.all.secret }),
    204,
    'abandon C'
  );

  const asKey = {
    actor_kind: 'api_key',
    actor_user_id: null,
    actor_api_key_id: keys.all.id,
    subject_api_key_id: null,
    community_id: c,
  };
  expect(await auditRows('community.create')).toContainEqual({
    ...asKey,
    prior_state: null,
    next_state: 'pending_owner',
    changed_fields: ['name', 'description', 'admission_policy'],
  });
  for (const action of ['owner_claim.reissue', 'owner_claim.revoke']) {
    expect(await auditRows(action)).toEqual([
      { ...asKey, prior_state: null, next_state: null, changed_fields: ['owner_claim'] },
    ]);
  }
  expect(await auditRows('community.abandon')).toEqual([
    { ...asKey, prior_state: 'pending_owner', next_state: null, changed_fields: [] },
  ]);
  // Field names only: no audit column holds a value the key sent.
  const audit = JSON.stringify((await h.pool.query('SELECT * FROM host_audit_events')).rows);
  expect(audit).not.toContain('Community C');
  expect(audit).not.toContain('Private words');
});

it('rows 12 and 16: a key suspends and resumes, and a revocation that commits while it waits wins', async () => {
  // Purpose: fails if the write transaction trusts the key it authenticated before waiting.
  const suspend = async (secret: string) =>
    call(`/api/v1/host/communities/${a}/lifecycle`, {
      method: 'PATCH',
      bearer: secret,
      body: { action: 'suspend', lifecycleVersion: (await lifecycleOf(a)).lifecycle_version },
    });
  await expectStatus(await suspend(keys.all.secret), 200, 'suspend A');
  await expectStatus(
    await call(`/api/v1/host/communities/${a}/lifecycle`, {
      method: 'PATCH',
      bearer: keys.all.secret,
      body: { action: 'resume', lifecycleVersion: (await lifecycleOf(a)).lifecycle_version },
    }),
    200,
    'resume A'
  );
  expect(
    (await auditRows('community.suspend')).map((row) => [row.actor_kind, row.actor_api_key_id])
  ).toEqual([['api_key', keys.all.id]]);
  expect(await auditRows('community.resume')).toEqual([
    {
      actor_kind: 'api_key',
      actor_user_id: null,
      actor_api_key_id: keys.all.id,
      subject_api_key_id: null,
      community_id: a,
      prior_state: 'suspended',
      next_state: 'active',
      changed_fields: ['lifecycle'],
    },
  ]);

  const doomed = await issueKey(['communities:lifecycle'], null, 'Doomed');
  const before = await lifecycleOf(a);
  const response = await holdingLock(
    h,
    'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
    [a],
    async (release) => {
      const pending = suspend(doomed.secret);
      await waitForLockWaiters(h, 1, 'FOR UPDATE OF c');
      await expectStatus(
        await call(`/api/v1/host/api-keys/${doomed.id}/revoke`, {
          cookie: operatorCookie,
          body: {},
        }),
        200,
        'revoke while waiting'
      );
      await release();
      return pending;
    }
  );
  expect(response.status).toBe(401);
  expect(await lifecycleOf(a)).toEqual(before);
});

it('rows 9 and 10: a key never manages keys, and a read key changes nothing and audits nothing', async () => {
  // Purpose: fails if a leaked key could make itself permanent, or if scopes are ignored.
  const version = (await lifecycleOf(a)).lifecycle_version;
  const keyRows = async () => (await h.pool.query('SELECT * FROM host_api_keys ORDER BY id')).rows;
  const beforeKeys = await keyRows();
  const management = [
    ['GET', '/api/v1/host/api-keys', undefined],
    [
      'POST',
      '/api/v1/host/api-keys',
      { label: 'Self', scopes: ALL_SCOPES, expiresInDays: null, password: TENANCY_PASSWORD },
    ],
    [
      'POST',
      `/api/v1/host/api-keys/${keys.all.id}/rotate`,
      { overlapMinutes: 0, password: TENANCY_PASSWORD },
    ],
    ['POST', `/api/v1/host/api-keys/${keys.read.id}/revoke`, {}],
  ] as const;
  for (const secret of [keys.all.secret, keys.read.secret]) {
    for (const [method, path, body] of management) {
      // Even with the operator's cookie beside it, a bearer on key management is refused.
      const response = await call(path, { method, bearer: secret, cookie: operatorCookie, body });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  }
  expect(await keyRows()).toEqual(beforeKeys);

  const before = await counts();
  const mutations = [
    ['POST', '/api/v1/host/communities', { idempotencyKey: 'read-key', name: 'Nope' }],
    ['POST', `/api/v1/host/communities/${a}/owner-claims/reissue`, {}],
    ['POST', `/api/v1/host/communities/${a}/owner-claims/${randomUUID()}/revoke`, {}],
    ['DELETE', `/api/v1/host/communities/${a}`, undefined],
    [
      'PATCH',
      `/api/v1/host/communities/${a}/lifecycle`,
      { action: 'suspend', lifecycleVersion: version },
    ],
  ] as const;
  for (const [method, path, body] of mutations) {
    const response = await call(path, { method, bearer: keys.read.secret, body });
    expect(response.status, `${method} ${path}`).toBe(403);
    expect((await response.json()).message).toBe('This key does not allow that action.');
  }
  expect(await counts()).toEqual(before);

  // The read key still reads, and a person holds every scope: the same suspend succeeds.
  await expectStatus(
    await call('/api/v1/host/communities', { bearer: keys.read.secret }),
    200,
    'read key lists'
  );
  await expectStatus(
    await call(`/api/v1/host/communities/${a}/lifecycle`, {
      method: 'PATCH',
      cookie: operatorCookie,
      body: { action: 'suspend', lifecycleVersion: version },
    }),
    200,
    'person suspends'
  );
  await expectStatus(
    await call(`/api/v1/host/communities/${a}/lifecycle`, {
      method: 'PATCH',
      cookie: operatorCookie,
      body: { action: 'resume', lifecycleVersion: version + 1 },
    }),
    200,
    'person resumes'
  );
});

it('rows 11, 13, and 14: revoked, expired, unknown, and member credentials are all 401 on host routes', async () => {
  // Purpose: fails if revocation or expiry is not enforced, if a cookie rescues a bad key, or
  // if a member's grant is mistaken for host authority.
  const list = (init: Parameters<TenancyHarness['call']>[1]) =>
    call('/api/v1/host/communities', init);
  expect((await list({ bearer: keys.expired.secret })).status).toBe(200);
  expect((await list({ bearer: keys.revoked.secret })).status).toBe(401);
  clockOffsetMs = 24 * 60 * 60_000 + 60_000;
  try {
    expect((await list({ bearer: keys.expired.secret })).status).toBe(401);
    // Expired behaves exactly like revoked, inside a write transaction too.
    expect(
      (
        await call(`/api/v1/host/communities/${a}/owner-claims/reissue`, {
          bearer: keys.expired.secret,
          body: {},
        })
      ).status
    ).toBe(401);
  } finally {
    clockOffsetMs = 0;
  }
  const unknown = mintHostApiKeySecret();
  expect((await list({ bearer: unknown, cookie: operatorCookie })).status).toBe(401);
  expect((await list({ bearer: 'not-a-key', cookie: operatorCookie })).status).toBe(401);
  expect(
    (await list({ headers: { authorization: 'Basic abc' }, cookie: operatorCookie })).status
  ).toBe(401);
  expect((await list({ bearer: memberBearer })).status).toBe(401);
  // Without any header the same cookie is the operator's own authority again.
  expect((await list({ cookie: operatorCookie })).status).toBe(200);
});

it('stores only the hash of a key and shows its issuer, even after that operator leaves', async () => {
  // Purpose: fails if any column holds the secret, or if removing an operator silently kills
  // the automation that operator set up.
  const stored = await h.pool.query(
    'SELECT to_jsonb(k)::text AS row, secret_hash FROM host_api_keys k WHERE id=$1',
    [keys.all.id]
  );
  expect(stored.rows[0].secret_hash).toBe(hashSecret(keys.all.secret));
  expect(stored.rows[0].row).not.toContain(keys.all.secret);
  expect(stored.rows[0].row).not.toContain(keys.all.secret.slice(10));

  const listed = await expectStatus(
    await call('/api/v1/host/api-keys', { cookie: operatorCookie }),
    200,
    'list keys'
  );
  const everything = (await listed.json()).keys.find(
    (key: { id: string }) => key.id === keys.all.id
  );
  expect(everything).toMatchObject({
    label: 'Everything',
    prefix: keys.all.secret.slice(0, 10),
    scopes: ALL_SCOPES,
    issuedVia: 'browser',
    issuedByOperator: 'Operator',
    expiresAt: null,
    revokedAt: null,
  });
  expect(everything.lastUsedAt).not.toBeNull();

  await h.pool.query('UPDATE host_operators SET revoked_at=now()');
  try {
    expect((await call('/api/v1/host/communities', { bearer: keys.all.secret })).status).toBe(200);
  } finally {
    await h.pool.query('UPDATE host_operators SET revoked_at=NULL');
  }
});

it('touches last use at most once a minute', async () => {
  // Purpose: fails if every request writes the key row, or if use is never recorded.
  const lastUsed = async () =>
    (
      await h.pool.query<{ last_used_at: Date }>(
        'SELECT last_used_at FROM host_api_keys WHERE id=$1',
        [keys.read.id]
      )
    ).rows[0].last_used_at.getTime();
  await call('/api/v1/host/communities', { bearer: keys.read.secret });
  const first = await lastUsed();
  clockOffsetMs = 30_000;
  await call('/api/v1/host/communities', { bearer: keys.read.secret });
  expect(await lastUsed()).toBe(first);
  clockOffsetMs = 2 * 60_000;
  await call('/api/v1/host/communities', { bearer: keys.read.secret });
  expect(await lastUsed()).toBeGreaterThan(first);
  clockOffsetMs = 0;
});

it('refuses issuing or rotating without the current password', async () => {
  // Purpose: fails if a borrowed browser session alone can mint a long-lived credential.
  const before = await counts();
  const beforeKeys = (await h.pool.query('SELECT count(*)::int AS n FROM host_api_keys')).rows[0];
  for (const [path, body] of [
    [
      '/api/v1/host/api-keys',
      { label: 'X', scopes: ['communities:read'], expiresInDays: 90, password: 'wrong-password-1' },
    ],
    [
      `/api/v1/host/api-keys/${keys.read.id}/rotate`,
      { overlapMinutes: 5, password: 'wrong-password-1' },
    ],
  ] as const) {
    expect((await call(path, { cookie: operatorCookie, body })).status).toBe(403);
  }
  expect(await counts()).toEqual(before);
  expect((await h.pool.query('SELECT count(*)::int AS n FROM host_api_keys')).rows[0]).toEqual(
    beforeKeys
  );
});

it('keeps a rotated key working for the overlap and refuses it one minute after', async () => {
  // Purpose: fails if rotation revokes the old key at once, or never.
  const old = await issueKey(['communities:read'], 90, 'Deploy');
  const rotated = await expectStatus(
    await call(
      `/api/v1/host/api-keys/${old.id}/rotate`,
      { cookie: operatorCookie, body: { overlapMinutes: 10, password: TENANCY_PASSWORD } },
      true
    ),
    201,
    'rotate'
  );
  expect(rotated.headers.get('cache-control')).toBe('no-store');
  const successor = await rotated.json();
  secrets.add(successor.secret);
  secrets.add(hashSecret(successor.secret));
  expect(successor.key).toMatchObject({ label: 'Deploy', scopes: ['communities:read'] });
  const lifetime = Date.parse(successor.key.expiresAt) - Date.parse(successor.key.createdAt);
  expect(lifetime).toBe(90 * 24 * 60 * 60_000);
  const list = (secret: string) => call('/api/v1/host/communities', { bearer: secret });
  try {
    clockOffsetMs = 10 * 60_000 - 5_000;
    expect((await list(old.secret)).status).toBe(200);
    expect((await list(successor.secret)).status).toBe(200);
    clockOffsetMs = 11 * 60_000;
    expect((await list(old.secret)).status).toBe(401);
    expect((await list(successor.secret)).status).toBe(200);
  } finally {
    clockOffsetMs = 0;
  }
  expect(
    (await auditRows('api_key.rotate')).map((row) => [row.actor_kind, row.subject_api_key_id])
  ).toEqual([['person', old.id]]);
  // A rotated-out or revoked key cannot be rotated again.
  expect(
    (
      await call(`/api/v1/host/api-keys/${keys.revoked.id}/rotate`, {
        cookie: operatorCookie,
        body: { overlapMinutes: 0, password: TENANCY_PASSWORD },
      })
    ).status
  ).toBe(409);
});

it('issues and revokes a key with the offline command, audited as the command', async () => {
  // Purpose: fails if the headless path skips the audit or issues a key that does not work.
  const issued = await runHostKeyCommand(h.pool, {
    kind: 'issue',
    label: 'Provisioner',
    scopes: ['communities:write', 'communities:read'],
    expiresInDays: 30,
  });
  if (issued.kind !== 'issue') throw new Error('expected an issued key');
  secrets.add(issued.secret);
  secrets.add(hashSecret(issued.secret));
  expect(issued.key).toMatchObject({
    issuedVia: 'command',
    issuedByOperator: null,
    scopes: ['communities:read', 'communities:write'],
  });
  expect((await call('/api/v1/host/communities', { bearer: issued.secret })).status).toBe(200);
  expect(await auditRows('api_key.issue')).toContainEqual({
    actor_kind: 'offline',
    actor_user_id: null,
    actor_api_key_id: null,
    subject_api_key_id: issued.key.id,
    community_id: null,
    prior_state: null,
    next_state: null,
    changed_fields: ['label', 'scopes', 'expires_at'],
  });
  await runHostKeyCommand(h.pool, { kind: 'revoke', keyId: issued.key.id });
  expect((await call('/api/v1/host/communities', { bearer: issued.secret })).status).toBe(401);
  expect(
    (await auditRows('api_key.revoke')).filter((row) => row.subject_api_key_id === issued.key.id)
  ).toEqual([expect.objectContaining({ actor_kind: 'offline', actor_user_id: null })]);
});

it('row 15: no response or log line carries a key secret, a hash, or a claim token', () => {
  // Purpose: fails if any refusal, list, or error echoes a credential outside its handoff.
  expect(secrets.size).toBeGreaterThan(10);
  for (const { label, text, oneTime } of bodies) {
    if (oneTime) continue;
    expect(text, label).not.toMatch(/dkh_[A-Za-z0-9_-]{20,}/);
    for (const secret of secrets) expect(text, label).not.toContain(secret);
  }
  for (const line of logLines) {
    expect(line).not.toMatch(/dkh_[A-Za-z0-9_-]{20,}/);
    for (const secret of secrets) expect(line).not.toContain(secret);
  }
});

it('counts failed key attempts against the caller', async () => {
  // Purpose: fails if unknown keys can be tried without limit from one address.
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 101; attempt++) {
    statuses.push(
      (await h.call('/api/v1/host/communities', { bearer: mintHostApiKeySecret() })).status
    );
    if (statuses.at(-1) === 429) break;
  }
  expect(statuses.at(-1)).toBe(429);
  expect(new Set(statuses.slice(0, -1))).toEqual(new Set([401]));
});

it('deletes a community’s limit rows with the tenant', async () => {
  // Purpose: fails if the deletion worker leaves host-set limits behind for a deleted tenant.
  const owner = await h.pool.query<{ id: string }>(
    "SELECT id FROM members WHERE community_id=$1 AND role='owner'",
    [a]
  );
  await h.pool.query('INSERT INTO community_limits(community_id,max_active_members) VALUES($1,5)', [
    a,
  ]);
  await h.pool.query(
    'INSERT INTO member_limit_overrides(community_id,member_id,agents_per_member) VALUES($1,$2,50)',
    [a, owner.rows[0].id]
  );
  await expectStatus(
    await h.call(`${tenant(a)}/owner/deletion`, {
      cookie: operatorCookie,
      body: {
        lifecycleVersion: (await lifecycleOf(a)).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Operator Community',
        confirmIdSuffix: a.slice(-8),
      },
    }),
    200,
    'request deletion'
  );
  await h.pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [a]
  );
  await h.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
     WHERE community_id=$1`,
    [a]
  );
  for (let pass = 0; pass < 10; pass++) {
    const result = await sweepCommunityDeletions(h.pool, h.blobStore, 100);
    if (result.completed) break;
    await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
  }
  expect((await h.pool.query('SELECT 1 FROM communities WHERE id=$1', [a])).rowCount).toBe(0);
  expect((await h.pool.query('SELECT 1 FROM community_limits')).rowCount).toBe(0);
  expect((await h.pool.query('SELECT 1 FROM member_limit_overrides')).rowCount).toBe(0);
  // Key audit rows are host-wide and outlive the tenant.
  expect((await auditRows('api_key.issue')).length).toBeGreaterThan(0);
});
