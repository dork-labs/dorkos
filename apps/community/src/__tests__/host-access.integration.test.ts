/**
 * The host-access read an installation uses to decide whether to offer
 * "Create a community" (spec `community-switcher-navigation`, lifecycle and
 * action routing; DOR-2242).
 *
 * It answers for the account behind the exact grant making the request, and
 * only for it: a member, another community's owner, and a revoked operator all
 * read "not an operator"; a grant never reads through another community's
 * path; and a signed-in browser without a grant gets nothing.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
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

let h: TenancyHarness;
let a = '';
let b = '';
/** First-install account: host operator and owner of A. */
let operator: TenancyMember;
/** A plain member of A. */
let member: TenancyMember;
/** Owns B, which the operator created, but does not run the host. */
let bOwner: TenancyMember;
/** The operator's own membership in B. */
let operatorInB: TenancyMember;

const hostAccess = (communityId: string) => `/api/v1/communities/${communityId}/me/host-access`;

async function readHostAccess(communityId: string, bearer: string) {
  const response = await expectStatus(
    await h.call(hostAccess(communityId), { bearer }),
    200,
    'host access'
  );
  expect(response.headers.get('cache-control')).toBe('no-store');
  return (await response.json()) as unknown;
}

beforeAll(async () => {
  h = await startTenancyHarness('host_access');
  const host = await bootstrapHost(h, 'Operator', 'operator@host-access.test');
  operator = { cookie: host.cookie, memberId: host.memberId };
  a = host.communityId;
  member = await admit(h, a, operator.cookie, { name: 'Member', email: 'member@host-access.test' });
  const pending = await createPendingCommunity(h, operator.cookie, 'Tenant B');
  b = pending.communityId;
  bOwner = await claimAsNewAccount(h, pending.token, 'B Owner', 'b-owner@host-access.test');
  operatorInB = await admit(h, b, bOwner.cookie, { cookie: operator.cookie });
});

afterAll(async () => {
  await h?.close();
});

it('says a host operator runs the host, through their own grant', async () => {
  const grant = await pairInstall(h, a, operator.cookie);
  expect(await readHostAccess(a, grant)).toEqual({ hostOperator: true });
});

it('says a plain member does not, even in a community the operator owns', async () => {
  const grant = await pairInstall(h, a, member.cookie, ['read']);
  expect(await readHostAccess(a, grant)).toEqual({ hostOperator: false });
});

it('says another community’s owner does not: owning a tenant is not running the host', async () => {
  const grant = await pairInstall(h, b, bOwner.cookie);
  expect(await readHostAccess(b, grant)).toEqual({ hostOperator: false });
});

it('keeps each grant inside its own community', async () => {
  const aGrant = await pairInstall(h, a, operator.cookie);
  const bGrant = await pairInstall(h, b, operatorInB.cookie);
  // Host authority belongs to the account, so it reads the same through B.
  expect(await readHostAccess(b, bGrant)).toEqual({ hostOperator: true });
  // A's grant cannot be used to ask on B's path, nor B's on A's.
  expect((await h.call(hostAccess(b), { bearer: aGrant })).status).toBe(401);
  expect((await h.call(hostAccess(a), { bearer: bGrant })).status).toBe(401);
});

it('answers only a grant, never a browser session or a revoked grant', async () => {
  expect((await h.call(hostAccess(a), { cookie: operator.cookie })).status).toBe(401);
  expect((await h.call(hostAccess(a), { bearer: 'not-a-grant' })).status).toBe(401);
  const grant = await pairInstall(h, a, operator.cookie);
  await h.pool.query(
    'UPDATE connection_grants SET revoked_at=now() WHERE member_id=$1 AND community_id=$2',
    [operator.memberId, a]
  );
  expect((await h.call(hostAccess(a), { bearer: grant })).status).toBe(401);
});

it('stops saying so the moment host authority is revoked', async () => {
  const grant = await pairInstall(h, b, operatorInB.cookie);
  expect(await readHostAccess(b, grant)).toEqual({ hostOperator: true });
  await h.pool.query(
    `UPDATE host_operators SET revoked_at=now()
     WHERE user_id=(SELECT user_id FROM members WHERE id=$1)`,
    [operatorInB.memberId]
  );
  expect(await readHostAccess(b, grant)).toEqual({ hostOperator: false });
});
