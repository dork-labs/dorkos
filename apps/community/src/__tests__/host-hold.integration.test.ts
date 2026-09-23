/**
 * Host hold and host-started deletion (spec `community-host-operator-api`, "Host hold and
 * host-started deletion"). A hold must stop growth without cutting the owner off from their
 * data, and a host may delete a community only after a hold with a published notice date.
 *
 * Tests run in order on one host with an injected clock. A is held and deleted; B, another
 * tenant, must stay untouched by all of it.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

const DAY = 24 * 60 * 60_000;
let h: TenancyHarness;
/** Added to the wall clock by the server's clock. */
let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
let operator: TenancyMember;
let member: TenancyMember;
let a = '';
let b = '';
let channelA = '';
let memberGrant = '';

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;

async function lifecycle(communityId = a) {
  return (
    await h.pool.query<{
      lifecycle: string;
      lifecycle_version: number;
      held_from_state: string | null;
      suspended_from_state: string | null;
    }>(
      `SELECT lifecycle,lifecycle_version,held_from_state,suspended_from_state
       FROM communities WHERE id=$1`,
      [communityId]
    )
  ).rows[0];
}

async function host(action: string, extra: Record<string, unknown> = {}, communityId = a) {
  return h.call(`/api/v1/host/communities/${communityId}/lifecycle`, {
    method: 'PATCH',
    cookie: operator.cookie,
    body: { action, lifecycleVersion: (await lifecycle(communityId)).lifecycle_version, ...extra },
  });
}

async function hostDelete(communityId = a) {
  return h.call(`/api/v1/host/communities/${communityId}/deletion`, {
    cookie: operator.cookie,
    body: {
      lifecycleVersion: (await lifecycle(communityId)).lifecycle_version,
      confirmIdSuffix: communityId.slice(-8),
    },
  });
}

const inDays = (days: number) => new Date(clock().getTime() + days * DAY).toISOString();

/** Every row a tenant owns, read straight from the tables that carry a community id. */
async function tenantRows(communityId: string): Promise<Record<string, unknown>> {
  const tables = (
    await h.pool.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
       WHERE table_schema='public' AND column_name='community_id' ORDER BY table_name`
    )
  ).rows.map((row) => row.table_name);
  const result: Record<string, unknown> = {
    communities: (
      await h.pool.query('SELECT to_jsonb(c)::text AS row FROM communities c WHERE id=$1', [
        communityId,
      ])
    ).rows,
  };
  for (const table of tables) {
    result[table] = (
      await h.pool.query(
        `SELECT to_jsonb(t)::text AS row FROM "${table}" t WHERE community_id=$1 ORDER BY 1`,
        [communityId]
      )
    ).rows;
  }
  return result;
}

let bBefore: Record<string, unknown>;

beforeAll(async () => {
  h = await startTenancyHarness('host_hold', { now: clock });
  const first = await bootstrapHost(h, 'Operator', 'operator@hold.test');
  operator = { cookie: first.cookie, memberId: first.memberId };
  a = first.communityId;
  channelA = first.channelId;
  member = await admit(h, a, operator.cookie, { name: 'Member', email: 'member@hold.test' });
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/join`, { cookie: member.cookie, body: {} }),
    200,
    'member joins'
  );
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      cookie: operator.cookie,
      body: { text: 'Before the hold', idempotencyKey: 'before' },
    }),
    201,
    'post before hold'
  );
  memberGrant = await pairInstall(h, a, member.cookie);
  await expectStatus(
    await h.call(`${tenant(a)}/agents`, {
      bearer: memberGrant,
      body: { localAgentId: 'agent-1', displayName: 'Agent One' },
    }),
    201,
    'enroll agent'
  );
  const pending = await createPendingCommunity(h, operator.cookie, 'Tenant B');
  b = pending.communityId;
  await claimAsNewAccount(h, pending.token, 'B Owner', 'b-owner@hold.test');
  bBefore = await tenantRows(b);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('refuses a notice shorter than the minimum, and a notice outside a hold', async () => {
  // Purpose: fails if a host could publish less notice than members are promised.
  for (const days of [1, 6, 13]) {
    const refused = await host('hold', { deletionNoticeAt: inDays(days) });
    expect(refused.status, `${days} days`).toBe(409);
  }
  expect((await host('set_notice', { deletionNoticeAt: inDays(30) })).status).toBe(409);
  expect((await lifecycle()).lifecycle).toBe('active');
});

it('holds A: revokes live credentials, and refuses every growing action with 423 COMMUNITY_HELD', async () => {
  // Purpose: fails if a hold reuses suspension (everything refused) or lets anything grow.
  await expectStatus(await host('hold', { deletionNoticeAt: null }), 200, 'hold');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'active' });
  const live = await h.pool.query(
    `SELECT (SELECT count(*)::int FROM connection_grants WHERE community_id=$1 AND revoked_at IS NULL) AS grants,
            (SELECT count(*)::int FROM agent_credentials WHERE community_id=$1 AND revoked_at IS NULL) AS credentials,
            (SELECT count(*)::int FROM agents WHERE community_id=$1 AND active) AS agents`,
    [a]
  );
  expect(live.rows[0]).toEqual({ grants: 0, credentials: 0, agents: 0 });

  const expectHeld = async (response: Response, label: string) => {
    expect(response.status, label).toBe(423);
    expect((await response.json()).code, label).toBe('COMMUNITY_HELD');
  };
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      cookie: member.cookie,
      body: { text: 'During the hold', idempotencyKey: 'during' },
    }),
    'post'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/attachments`, {
      method: 'POST',
      cookie: member.cookie,
      headers: {
        'content-type': 'text/plain',
        'x-file-name': 'held.txt',
        'x-file-size': '1',
        'idempotency-key': 'held-file',
      },
      raw: 'a',
    }),
    'upload'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/invites`, { cookie: operator.cookie, body: { seats: 1 } }),
    'invitation'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/invites/redeem`, { cookie: member.cookie, body: {} }),
    'join'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/channels`, {
      cookie: operator.cookie,
      body: { name: 'new-room', visibility: 'public' },
    }),
    'new channel'
  );
  const settings = await h.call(`${tenant(a)}/settings`, { cookie: operator.cookie });
  expect(settings.status).toBe(200);
  await expectHeld(
    await h.call(`${tenant(a)}/settings`, {
      method: 'PATCH',
      cookie: operator.cookie,
      headers: { 'if-match': `"${(await settings.json()).settingsVersion}"` },
      body: { name: 'Renamed while held' },
    }),
    'settings edit'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/owner/lifecycle`, {
      cookie: operator.cookie,
      body: {
        action: 'archive',
        lifecycleVersion: (await lifecycle()).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Operator Community',
      },
    }),
    'owner archive'
  );
  // A write-scope pairing is refused; only the read-only pairing an archive allows works.
  const writePairing = await h.call(`${tenant(a)}/pairings/start`, {
    headers: { origin: '' },
    body: { installName: 'Writer', challenge: 'x'.repeat(43), scopes: ['read', 'post'] },
  });
  await expectHeld(writePairing, 'write pairing');
  // Defence in depth: a grant that somehow survived the hold still cannot enroll an agent.
  await h.pool.query('UPDATE connection_grants SET revoked_at=NULL WHERE community_id=$1', [a]);
  await expectHeld(
    await h.call(`${tenant(a)}/agents`, {
      bearer: memberGrant,
      body: { localAgentId: 'agent-2', displayName: 'Agent Two' },
    }),
    'agent enrollment'
  );
  await h.pool.query(
    'UPDATE connection_grants SET revoked_at=now() WHERE community_id=$1 AND revoked_at IS NULL',
    [a]
  );
});

it('still serves history, read-only pairing, and the owner’s export while held', async () => {
  // Purpose: fails if the hold cuts members off from reading or the owner off from their data.
  const history = await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, { cookie: member.cookie }),
    200,
    'history'
  );
  expect(JSON.stringify(await history.json())).toContain('Before the hold');
  const readOnly = await pairInstall(h, a, member.cookie, ['read']);
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, { bearer: readOnly }),
    200,
    'history through a read-only installation'
  );
  // Installations know only the archived word for a read-only community.
  const access = await expectStatus(
    await h.call(`${tenant(a)}/me/connection-access`, { bearer: readOnly }),
    200,
    'connection access'
  );
  expect((await access.json()).access.lastKnown.lifecycle).toBe('archived');
  await expectStatus(
    await h.call(`${tenant(a)}/owner/export`, {
      cookie: operator.cookie,
      body: { password: TENANCY_PASSWORD },
    }),
    201,
    'owner export while held'
  );
  const memberships = await expectStatus(
    await h.call('/api/v1/memberships', { cookie: member.cookie }),
    200,
    'memberships'
  );
  expect((await memberships.json()).memberships).toEqual([
    expect.objectContaining({ communityId: a, lifecycle: 'held', deletionNoticeAt: null }),
  ]);
});

it('suspends from the hold and resumes back to it, and releases to where it began reviving nothing', async () => {
  // Purpose: fails if a suspension forgets the hold, or if release restores a revoked credential.
  await expectStatus(await host('suspend'), 200, 'suspend held');
  expect(await lifecycle()).toMatchObject({
    lifecycle: 'suspended',
    suspended_from_state: 'held',
    held_from_state: 'active',
  });
  await expectStatus(await host('resume'), 200, 'resume to held');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'active' });
  await expectStatus(await host('release'), 200, 'release');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'active', held_from_state: null });
  expect(
    (
      await h.pool.query(
        'SELECT count(*)::int AS n FROM connection_grants WHERE community_id=$1 AND revoked_at IS NULL',
        [a]
      )
    ).rows[0].n
  ).toBe(0);
  expect(
    (await h.call(`${tenant(a)}/channels/${channelA}/entries`, { bearer: memberGrant })).status
  ).toBe(401);
});

it('refuses host deletion from active, archived, suspended, held without notice, and before the notice date', async () => {
  // Purpose: fails if any gate before host-started deletion is missing.
  const refused = async (label: string) => {
    const response = await hostDelete();
    expect(response.status, label).toBe(409);
  };
  await refused('active');
  await expectStatus(
    await h.call(`${tenant(a)}/owner/lifecycle`, {
      cookie: operator.cookie,
      body: {
        action: 'archive',
        lifecycleVersion: (await lifecycle()).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Operator Community',
      },
    }),
    200,
    'owner archives'
  );
  await refused('archived');
  await expectStatus(await host('suspend'), 200, 'suspend archived');
  await refused('suspended');
  await expectStatus(await host('resume'), 200, 'resume archived');
  await expectStatus(await host('hold', { deletionNoticeAt: null }), 200, 'hold archived');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'archived' });
  await refused('held without notice');
  await expectStatus(
    await host('set_notice', { deletionNoticeAt: inDays(14.01) }),
    200,
    'publish notice'
  );
  // A published notice cannot be shortened below the minimum, but can be moved later.
  expect((await host('set_notice', { deletionNoticeAt: inDays(10) })).status).toBe(409);
  await expectStatus(await host('set_notice', { deletionNoticeAt: inDays(20) }), 200, 'later');
  const memberships = await h.call('/api/v1/memberships', { cookie: member.cookie });
  expect(
    (await memberships.json()).memberships.find(
      (row: { communityId: string }) => row.communityId === a
    ).deletionNoticeAt
  ).not.toBeNull();
  clockOffsetMs = 19 * DAY;
  await refused('before the notice date');
  // The last eight characters of the id must match, so a script cannot delete the wrong one.
  clockOffsetMs = 21 * DAY;
  const wrongSuffix = await h.call(`/api/v1/host/communities/${a}/deletion`, {
    cookie: operator.cookie,
    body: { lifecycleVersion: (await lifecycle()).lifecycle_version, confirmIdSuffix: b.slice(-8) },
  });
  expect(wrongSuffix.status).toBe(409);
});

it('deletes A after the notice date with a host requester, which only the host can cancel, back to the hold', async () => {
  // Purpose: fails if host deletion skips the seven days, lets the owner cancel it, or a cancel
  // lifts the hold.
  const started = await expectStatus(await hostDelete(), 200, 'host deletion');
  expect(await started.json()).toMatchObject({
    lifecycle: 'deletion_pending',
    deletionRequestedBy: 'host',
  });
  const row = await h.pool.query<{
    delete_requested_at: Date;
    delete_after: Date;
    delete_requested_by: string | null;
    host: string;
  }>(
    `SELECT delete_requested_at,delete_after,delete_requested_by,
            delete_requested_by_host_actor AS host FROM communities WHERE id=$1`,
    [a]
  );
  expect(row.rows[0].delete_after.getTime() - row.rows[0].delete_requested_at.getTime()).toBe(
    7 * DAY
  );
  expect(row.rows[0].delete_requested_by).toBeNull();
  expect(row.rows[0].host).toMatch(/^person:/);

  const ownerCancel = await h.call(`${tenant(a)}/owner/deletion/cancel`, {
    cookie: operator.cookie,
    body: { lifecycleVersion: (await lifecycle()).lifecycle_version, password: TENANCY_PASSWORD },
  });
  expect(ownerCancel.status).toBe(409);
  await expectStatus(
    await h.call(`/api/v1/host/communities/${a}/deletion`, {
      method: 'DELETE',
      cookie: operator.cookie,
    }),
    200,
    'host cancels'
  );
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'archived' });
});

it('lets the owner delete a held community, cancels that back to the hold, and keeps the host out of it', async () => {
  // Purpose: fails if the hold traps an owner, if the owner's cancel lifts the hold, or if the
  // host can cancel an owner's deletion.
  await expectStatus(
    await h.call(`${tenant(a)}/owner/deletion`, {
      cookie: operator.cookie,
      body: {
        lifecycleVersion: (await lifecycle()).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Operator Community',
        confirmIdSuffix: a.slice(-8),
      },
    }),
    200,
    'owner deletes while held'
  );
  expect(
    (
      await h.call(`/api/v1/host/communities/${a}/deletion`, {
        method: 'DELETE',
        cookie: operator.cookie,
      })
    ).status
  ).toBe(409);
  await expectStatus(
    await h.call(`${tenant(a)}/owner/deletion/cancel`, {
      cookie: operator.cookie,
      body: { lifecycleVersion: (await lifecycle()).lifecycle_version, password: TENANCY_PASSWORD },
    }),
    200,
    'owner cancels'
  );
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'archived' });
});

it('leaves community B untouched by every hold, release, and deletion of A', async () => {
  // Purpose: fails if any host lifecycle change reaches another tenant.
  expect(await tenantRows(b)).toEqual(bBefore);
});
