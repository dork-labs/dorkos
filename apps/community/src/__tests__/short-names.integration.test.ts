/**
 * Community short names (spec `community-host-operator-api`, P6). A short name is an address
 * alias, never identity: retired names keep leading to their community, a released or deleted
 * name is held back from reuse without being stored in clear text, and the public lookup
 * answers every name it will not resolve with the same 404.
 *
 * Tests run in order on one host with an injected clock.
 */
import { randomBytes, createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { runHostKeyCommand } from '../host-keys.js';
import { shortNameHoldKey } from '../host/short-names.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

const DAY = 24 * 60 * 60_000;
let h: TenancyHarness;
let clockOffsetMs = 0;
let operator: TenancyMember;
let a = '';
let b = '';
let key = '';

async function lifecycleVersion(communityId: string): Promise<number> {
  return (
    await h.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0].lifecycle_version;
}

const setName = (communityId: string, shortName: string | null) =>
  h.call(`/api/v1/host/communities/${communityId}/short-name`, {
    method: 'PUT',
    bearer: key,
    body: { shortName },
  });
const lookup = (name: string) => h.call(`/api/v1/community-names/${encodeURIComponent(name)}`);
const availability = async (name: string) =>
  (
    await expectStatus(
      await h.call(`/api/v1/host/short-names/${name}`, { bearer: key }),
      200,
      'availability'
    )
  ).json();

/** Every row of every table, as text, so a test can prove a name is gone from all of them. */
async function everyRow(): Promise<string> {
  const tables = (
    await h.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'`
    )
  ).rows.map((row) => row.table_name);
  const rows: string[] = [];
  for (const table of tables) {
    const result = await h.pool.query(`SELECT to_jsonb(t)::text AS row FROM "${table}" t`);
    rows.push(...result.rows.map((row) => row.row as string));
  }
  return rows.join('\n');
}

beforeAll(async () => {
  h = await startTenancyHarness('short_names', { now: () => new Date(Date.now() + clockOffsetMs) });
  const first = await bootstrapHost(h, 'Operator', 'operator@names.test');
  operator = { cookie: first.cookie, memberId: first.memberId };
  a = first.communityId;
  const pending = await createPendingCommunity(h, operator.cookie, 'Tenant B');
  b = pending.communityId;
  await claimAsNewAccount(h, pending.token, 'B Owner', 'b-owner@names.test');
  const issued = await runHostKeyCommand(h.pool, {
    kind: 'issue',
    label: 'Names',
    scopes: ['communities:read', 'communities:write', 'communities:lifecycle'],
    expiresInDays: null,
  });
  if (issued.kind !== 'issue') throw new Error('expected a key');
  key = issued.secret;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('resolves a name, keeps resolving it after a rename, and keeps it from anyone else', async () => {
  // Purpose: fails if a rename releases the old name, which would let another community take
  // over a bookmarked address.
  const named = await expectStatus(await setName(a, '  Acme '), 200, 'name A');
  expect((await named.json()).shortName).toBe('acme');
  expect(await (await expectStatus(await lookup('acme'), 200, 'lookup')).json()).toEqual({
    communityId: a,
    shortName: 'acme',
  });
  await expectStatus(await setName(a, 'acme-labs'), 200, 'rename A');
  expect(await (await expectStatus(await lookup('acme'), 200, 'old name')).json()).toEqual({
    communityId: a,
    shortName: 'acme-labs',
  });
  expect(await (await expectStatus(await lookup('ACME-LABS'), 200, 'any case')).json()).toEqual({
    communityId: a,
    shortName: 'acme-labs',
  });
  const takeover = await setName(b, 'acme');
  expect(takeover.status).toBe(409);
  expect((await takeover.json()).code).toBe('SHORT_NAME_TAKEN');
  expect((await availability('acme')).availability).toBe('taken');
  // A community may take back its own retired name.
  await expectStatus(await setName(a, 'acme'), 200, 'A takes acme back');
  await expectStatus(await setName(a, 'acme-labs'), 200, 'A back to acme-labs');
  const names = await expectStatus(
    await h.call(`/api/v1/host/communities/${a}/short-names`, { bearer: key }),
    200,
    'names'
  );
  expect(await names.json()).toMatchObject({
    current: 'acme-labs',
    retired: [expect.objectContaining({ shortName: 'acme' })],
  });
});

it('refuses reserved names, including the host’s own additions', async () => {
  // Purpose: fails if a community could claim a path the server or browser owns.
  for (const name of ['admin', 'host', 'api', 'c']) {
    const refused = await setName(b, name);
    expect(refused.status, name).toBe(name === 'c' ? 400 : 409);
    if (name !== 'c') expect((await refused.json()).code).toBe('SHORT_NAME_RESERVED');
  }
  h.config.reservedShortNames.add('our-brand');
  const refused = await setName(b, 'our-brand');
  expect((await refused.json()).code).toBe('SHORT_NAME_RESERVED');
  expect((await availability('our-brand')).availability).toBe('reserved');
  expect((await availability('Not A Name!')).availability).toBe('invalid');
});

it('holds a released name for the cool-off, without keeping it in clear text, then frees it', async () => {
  // Purpose: fails if the hold is missing, is stored as the name itself, or never ends.
  await expectStatus(
    await h.call(`/api/v1/host/communities/${a}/short-names/acme`, {
      method: 'DELETE',
      bearer: key,
    }),
    204,
    'release acme'
  );
  expect((await lookup('acme')).status).toBe(404);
  const held = await availability('acme');
  expect(held.availability).toBe('cooling_off');
  expect(Date.parse(held.availableAt) - Date.now()).toBeGreaterThan(89 * DAY);
  expect((await setName(b, 'acme')).status).toBe(409);
  const hmac = createHash('sha256').update('acme').digest('hex');
  const stored = await h.pool.query<{ name_hmac: string }>(
    'SELECT name_hmac FROM released_short_names'
  );
  expect(stored.rows.map((row) => row.name_hmac)).not.toContain(hmac);
  expect(JSON.stringify(stored.rows)).not.toContain('acme');
  clockOffsetMs = 91 * DAY;
  try {
    expect((await availability('acme')).availability).toBe('available');
    await expectStatus(await setName(b, 'acme'), 200, 'B takes acme after the cool-off');
  } finally {
    clockOffsetMs = 0;
  }
  await expectStatus(await setName(b, null), 200, 'B clears its name');
  expect((await lookup('acme')).status).toBe(200);
});

it('lifts one hold on request, and the audit names the action but not the name', async () => {
  // Purpose: fails if a hold cannot be lifted early, or if the name leaks into the audit.
  await expectStatus(await setName(b, 'beta-one'), 200, 'name B');
  await expectStatus(await setName(b, 'beta-two'), 200, 'rename B');
  await expectStatus(
    await h.call(`/api/v1/host/communities/${b}/short-names/beta-one`, {
      method: 'DELETE',
      bearer: key,
    }),
    204,
    'release beta-one'
  );
  expect((await availability('beta-one')).availability).toBe('cooling_off');
  await expectStatus(
    await h.call('/api/v1/host/short-name-holds/beta-one', { method: 'DELETE', bearer: key }),
    204,
    'lift hold'
  );
  expect((await availability('beta-one')).availability).toBe('available');
  expect(
    (await h.call('/api/v1/host/short-name-holds/beta-one', { method: 'DELETE', bearer: key }))
      .status
  ).toBe(404);
  const audit = JSON.stringify(
    (
      await h.pool.query(
        "SELECT * FROM host_audit_events WHERE action LIKE 'community.short_name%'"
      )
    ).rows
  );
  expect(audit).toContain('community.short_name.hold_release');
  expect(audit).not.toContain('beta-one');
});

it('frees the name of a never-claimed community at once when it is abandoned', async () => {
  // Purpose: nobody ever reached an unclaimed community by its name, so holding it would only
  // block the same person trying again; fails if abandoning holds the name.
  const created = await expectStatus(
    await h.call('/api/v1/host/communities', {
      bearer: key,
      body: { idempotencyKey: 'fresh-start', name: 'Fresh', shortName: 'fresh-start' },
    }),
    201,
    'create with a name'
  );
  const body = await created.json();
  expect(body.community.shortName).toBe('fresh-start');
  // The same key with a different name is a different request.
  const conflict = await h.call('/api/v1/host/communities', {
    bearer: key,
    body: { idempotencyKey: 'fresh-start', name: 'Fresh', shortName: 'fresh-other' },
  });
  expect((await conflict.json()).code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await lookup('fresh-start')).status).toBe(404);
  const holdsBefore = (await h.pool.query('SELECT count(*)::int AS n FROM released_short_names'))
    .rows[0].n;
  await expectStatus(
    await h.call(
      `/api/v1/host/communities/${body.community.id}/owner-claims/${body.ownerClaimGrantId}/revoke`,
      { bearer: key, body: {} }
    ),
    204,
    'revoke claim'
  );
  await expectStatus(
    await h.call(`/api/v1/host/communities/${body.community.id}`, {
      method: 'DELETE',
      bearer: key,
    }),
    204,
    'abandon'
  );
  expect((await availability('fresh-start')).availability).toBe('available');
  expect(
    (await h.pool.query('SELECT count(*)::int AS n FROM released_short_names')).rows[0].n
  ).toBe(holdsBefore);
});

it('answers every name it will not resolve with the identical 404', async () => {
  // Purpose: fails if the lookup tells unknown, reserved, malformed, unclaimed, and suspended
  // apart, which would let anyone probe what a host has.
  await createPendingCommunity(h, operator.cookie, 'Unclaimed');
  const unclaimed = (
    await h.pool.query<{ id: string }>("SELECT id FROM communities WHERE name='Unclaimed'")
  ).rows[0].id;
  await expectStatus(await setName(unclaimed, 'not-yet'), 200, 'name the unclaimed community');
  await expectStatus(await setName(b, 'paused-one'), 200, 'name B');
  await expectStatus(
    await h.call(`/api/v1/host/communities/${b}/lifecycle`, {
      method: 'PATCH',
      bearer: key,
      body: { action: 'suspend', lifecycleVersion: await lifecycleVersion(b) },
    }),
    200,
    'suspend B'
  );
  const bodies = [];
  for (const name of ['never-was', 'host', 'A%21', 'not-yet', 'paused-one', 'ab']) {
    const response = await lookup(name);
    expect(response.status, name).toBe(404);
    bodies.push(await response.text());
  }
  expect(new Set(bodies).size).toBe(1);
  await expectStatus(
    await h.call(`/api/v1/host/communities/${b}/lifecycle`, {
      method: 'PATCH',
      bearer: key,
      body: { action: 'resume', lifecycleVersion: await lifecycleVersion(b) },
    }),
    200,
    'resume B'
  );
  expect((await lookup('paused-one')).status).toBe(200);
});

it('keeps pairing links on the community UUID, never its name', async () => {
  // Purpose: fails if a server-minted link used the mutable name as identity.
  const verifier = randomBytes(32).toString('base64url');
  const started = await expectStatus(
    await h.call(`/api/v1/communities/${a}/pairings/start`, {
      headers: { origin: '' },
      body: {
        installName: 'Named install',
        challenge: createHash('sha256').update(verifier).digest('base64url'),
        scopes: ['read'],
      },
    }),
    201,
    'pairing start'
  );
  const approvalUrl = (await started.json()).approvalUrl as string;
  expect(approvalUrl).toContain(`/c/${a}/pairing`);
  expect(approvalUrl).not.toContain('acme-labs');
});

it('holds a deleted community’s names and leaves no row that contains them', async () => {
  // Purpose: fails if deletion frees a name at once, or keeps any name in clear text.
  await expectStatus(await setName(a, 'zeta-vanish'), 200, 'name A');
  await expectStatus(
    await h.call(`/api/v1/communities/${a}/owner/deletion`, {
      cookie: operator.cookie,
      body: {
        lifecycleVersion: await lifecycleVersion(a),
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
  // Without the hold key the worker refuses to finish, rather than freeing the names.
  await sweepCommunityDeletions(h.pool, h.blobStore, 100).catch(() => undefined);
  await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
  expect((await h.pool.query('SELECT 1 FROM communities WHERE id=$1', [a])).rowCount).toBe(1);
  const holds = {
    key: shortNameHoldKey(h.config.authSecret),
    cooloffDays: h.config.limits.shortNameCooloffDays,
  };
  for (let pass = 0; pass < 10; pass++) {
    const result = await sweepCommunityDeletions(h.pool, h.blobStore, 100, {
      shortNameHolds: holds,
    });
    if (result.completed) break;
    await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
  }
  expect((await h.pool.query('SELECT 1 FROM communities WHERE id=$1', [a])).rowCount).toBe(0);
  const all = await everyRow();
  for (const name of ['zeta-vanish', 'acme-labs']) {
    expect(all, name).not.toContain(name);
    expect((await availability(name)).availability, name).toBe('cooling_off');
  }
});

it('limits lookups per caller', async () => {
  // Purpose: fails if anyone can probe names without limit.
  h.config.limits.nameLookupsPerMinute = 1;
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt++) statuses.push((await lookup('anything')).status);
    expect(statuses).toContain(429);
  } finally {
    h.config.limits.nameLookupsPerMinute = 600;
  }
});
