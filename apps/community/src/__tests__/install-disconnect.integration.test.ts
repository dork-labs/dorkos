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

it('DorkOS Disconnect ends the grant on the Community, not just the local copy', async () => {
  const token = await pairInstall(h, communityId, ownerCookie);
  const grant = await grantIdOf(token);
  expect(await listedGrantIds()).toContain(grant);
  const directory = await mkdtemp(join(tmpdir(), 'community-disconnect-local-'));
  try {
    // Plant the exchanged grant in the local store exactly as a completed pairing leaves it.
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

    const service = new RemoteCommunityPairingService(store);
    expect(await service.disconnect(ref, ownerKey)).toEqual({ remoteRevoked: true });

    expect(await listedGrantIds()).not.toContain(grant);
    expect((await h.call(`${tenant()}/me/connection-access`, { bearer: token })).status).toBe(401);
    expect(await store.list(ownerKey)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
