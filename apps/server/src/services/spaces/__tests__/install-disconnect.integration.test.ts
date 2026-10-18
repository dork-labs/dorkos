/**
 * A local install disconnecting itself: `DELETE /me/connection` with the
 * install's own bearer revokes exactly that install's grant, on real Postgres
 * and a running server.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import { RemoteConnectionStore } from '../../../server/src/services/communities/remote/connection-store.js';
import { RemoteCommunityPairingService } from '../../../server/src/services/communities/remote/pairing-service.js';
import {
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import { hashSecret } from '../security.js';

let h: TenancyHarness;
let communityId = '';
let ownerCookie = '';

const tenant = () => `/api/v1/communities/${communityId}`;

async function listedGrantIds(): Promise<string[]> {
  const response = await expectStatus(
    await h.call(`${tenant()}/me/grants`, { cookie: ownerCookie }),
    200,
    'list grants'
  );
  return ((await response.json()).grants as Array<{ id: string }>).map((grant) => grant.id);
}

async function grantIdOf(token: string): Promise<string> {
  const result = await h.pool.query<{ id: string }>(
    'SELECT id FROM connection_grants WHERE token_hash=$1',
    [hashSecret(token)]
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  h = await startTenancyHarness('disconnect');
  const host = await bootstrapHost(h, 'Owner', 'owner@disconnect.test');
  communityId = host.communityId;
  ownerCookie = host.cookie;
});

afterAll(async () => {
  await h?.close();
});

it('revokes only the calling install’s grant, and a retry still succeeds', async () => {
  const laptop = await pairInstall(h, communityId, ownerCookie);
  const desktop = await pairInstall(h, communityId, ownerCookie);
  const laptopGrant = await grantIdOf(laptop);
  const desktopGrant = await grantIdOf(desktop);
  expect((await listedGrantIds()).sort()).toEqual([laptopGrant, desktopGrant].sort());

  await expectStatus(
    await h.call(`${tenant()}/me/connection`, { method: 'DELETE', bearer: laptop }),
    204,
    'install revokes itself'
  );

  // The Community no longer lists or accepts the disconnected install…
  expect(await listedGrantIds()).toEqual([desktopGrant]);
  expect((await h.call(`${tenant()}/me/connection-access`, { bearer: laptop })).status).toBe(401);
  // …and the other install is untouched.
  expect((await h.call(`${tenant()}/me/connection-access`, { bearer: desktop })).status).toBe(200);

  const audit = await h.pool.query<{ action: string; subject_id: string }>(
    "SELECT action,subject_id FROM audit_events WHERE action='grant.revoke'"
  );
  expect(audit.rows).toEqual([{ action: 'grant.revoke', subject_id: laptopGrant }]);

  // A retry after a lost response is harmless and writes no second audit row.
  await expectStatus(
    await h.call(`${tenant()}/me/connection`, { method: 'DELETE', bearer: laptop }),
    204,
    'retried revocation'
  );
  expect(
    (await h.pool.query("SELECT 1 FROM audit_events WHERE action='grant.revoke'")).rowCount
  ).toBe(1);
});

it('refuses a bearer that is not a grant, and a request with none', async () => {
  expect(
    (await h.call(`${tenant()}/me/connection`, { method: 'DELETE', bearer: 'not-a-grant' })).status
  ).toBe(401);
  expect((await h.call(`${tenant()}/me/connection`, { method: 'DELETE' })).status).toBe(401);
});

it('refuses one community’s bearer at another community’s address', async () => {
  const pending = await createPendingCommunity(h, ownerCookie, 'Community B');
  await claimAsNewAccount(h, pending.token, 'B Owner', 'b-owner@disconnect.test');
  const install = await pairInstall(h, communityId, ownerCookie);
  const grant = await grantIdOf(install);

  expect(
    (
      await h.call(`/api/v1/communities/${pending.communityId}/me/connection`, {
        method: 'DELETE',
        bearer: install,
      })
    ).status
  ).toBe(401);

  // The grant in community A is untouched and still works there.
  expect(await listedGrantIds()).toContain(grant);
  expect((await h.call(`${tenant()}/me/connection-access`, { bearer: install })).status).toBe(200);
});

it('lets an install disconnect from a suspended community', async () => {
  const install = await pairInstall(h, communityId, ownerCookie);
  const grant = await grantIdOf(install);
  await h.pool.query(
    `UPDATE communities SET lifecycle='suspended',suspended_from_state='active',suspended_at=now()
     WHERE id=$1`,
    [communityId]
  );
  try {
    await expectStatus(
      await h.call(`${tenant()}/me/connection`, { method: 'DELETE', bearer: install }),
      204,
      'revoke while suspended'
    );
  } finally {
    await h.pool.query(
      `UPDATE communities SET lifecycle='active',suspended_from_state=NULL,suspended_at=NULL
       WHERE id=$1`,
      [communityId]
    );
  }
  const revoked = await h.pool.query<{ revoked: boolean }>(
    'SELECT revoked_at IS NOT NULL AS revoked FROM connection_grants WHERE id=$1',
    [grant]
  );
  expect(revoked.rows[0]!.revoked).toBe(true);
});

/**
 * A local connection store holding one exchanged grant exactly as a completed pairing leaves it,
 * in its own folder the caller removes.
 */
async function plantConnection(token: string) {
  const directory = await mkdtemp(join(tmpdir(), 'community-disconnect-local-'));
  const store = new RemoteConnectionStore(directory);
  const ref = CommunityRefSchema.parse(`remote_${randomUUID().replaceAll('-', '')}`);
  const ownerKey = 'local-owner';
  await store.addPending(
    {
      ref,
      ownerKey,
      remoteCommunityId: communityId,
      label: 'Owner Community',
      pinnedOrigin: h.baseUrl,
      pairingId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    randomUUID()
  );
  const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
  await store.complete(ref, ownerKey, randomUUID(), token, {
    state: 'verified',
    effective: capabilities,
    lastKnown: { lifecycle: 'active', capabilities, verifiedAt: new Date().toISOString() },
  });
  return { directory, store, ref, ownerKey };
}

async function enrollAgent(grant: string, localAgentId: string) {
  const response = await expectStatus(
    await h.call(`${tenant()}/agents`, {
      bearer: grant,
      body: { localAgentId, displayName: 'Researcher' },
    }),
    201,
    `enroll ${localAgentId}`
  );
  return (await response.json()) as { token: string; agent: { memberId: string } };
}

async function agentActive(id: string): Promise<boolean> {
  return (await h.pool.query<{ active: boolean }>('SELECT active FROM agents WHERE id=$1', [id]))
    .rows[0]!.active;
}

it('DorkOS Disconnect ends the grant on the Community, not just the local copy', async () => {
  const token = await pairInstall(h, communityId, ownerCookie);
  const grant = await grantIdOf(token);
  expect(await listedGrantIds()).toContain(grant);
  const { directory, store, ref, ownerKey } = await plantConnection(token);
  try {
    const service = new RemoteCommunityPairingService(store);
    expect(await service.disconnect(ref, ownerKey)).toEqual({
      remoteRevoked: true,
      agentsNotRemoved: [],
    });

    expect(await listedGrantIds()).not.toContain(grant);
    expect((await h.call(`${tenant()}/me/connection-access`, { bearer: token })).status).toBe(401);
    expect(await store.list(ownerKey)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// DOR-2612: the Community records which grant enrolled each agent, so a laptop and a desktop of
// the same person that run the same agent files (one local agent id) hold one agent each, and
// the laptop's Disconnect removes only its own.
it('DorkOS Disconnect on a laptop leaves the desktop’s agent with the same local id running', async () => {
  const laptop = await pairInstall(h, communityId, ownerCookie);
  const desktop = await pairInstall(h, communityId, ownerCookie);
  const onLaptop = await enrollAgent(laptop, 'shared-researcher');
  const onDesktop = await enrollAgent(desktop, 'shared-researcher');
  expect(onDesktop.agent.memberId).not.toBe(onLaptop.agent.memberId);

  const local = await plantConnection(laptop);
  try {
    // The laptop's own records: its agent, and a stale row naming the desktop's agent, as a
    // record could after the desktop took over a legacy agent. Both are active here.
    const service = new RemoteCommunityPairingService(
      local.store,
      undefined,
      undefined,
      {},
      undefined,
      () => [
        {
          localAgentId: 'shared-researcher',
          remoteMemberId: onLaptop.agent.memberId,
          displayName: 'Researcher',
          active: true,
        },
        {
          localAgentId: 'stale-record',
          remoteMemberId: onDesktop.agent.memberId,
          displayName: 'Stale',
          active: true,
        },
      ]
    );
    // The Community answers the stale one "not found": it is not the laptop's to remove, so
    // from here it is gone, and the person is not told to finish anything.
    expect(await service.disconnect(local.ref, local.ownerKey)).toEqual({
      remoteRevoked: true,
      agentsNotRemoved: [],
    });
  } finally {
    await rm(local.directory, { recursive: true, force: true });
  }

  expect(await agentActive(onLaptop.agent.memberId)).toBe(false);
  expect(await agentActive(onDesktop.agent.memberId)).toBe(true);
  expect((await h.call(`${tenant()}/channels`, { bearer: onDesktop.token })).status).toBe(200);
  expect((await h.call(`${tenant()}/me/connection-access`, { bearer: desktop })).status).toBe(200);
});
