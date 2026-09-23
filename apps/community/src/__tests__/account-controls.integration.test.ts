import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  TENANCY_PASSWORD,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';
import { responseCookies } from './bootstrap-test-helper.js';

// specs/community-membership-journeys task 2.3: "Sign out this browser" ends the current host
// session only, and "Disconnect all my installations from this community" revokes that one
// membership's personal grants only. Each scope is proven against its nearest neighbours: the
// same account's other browser and other community, and another member of the same community.

const OWNER_EMAIL = 'owner@account-controls.test';
let h: TenancyHarness;
let first: string;
let second: string;
let owner: TenancyMember;
let ownerInSecond: TenancyMember;
let neighbour: TenancyMember;
let secondOwner: TenancyMember;

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;

async function installWorks(communityId: string, bearer: string) {
  const response = await h.call(`${tenant(communityId)}/me/connection-access`, { bearer });
  return response.status;
}

async function signInAgain(email: string) {
  const response = await expectStatus(
    await h.call('/api/auth/sign-in/email', { body: { email, password: TENANCY_PASSWORD } }),
    200,
    `sign in ${email}`
  );
  return responseCookies(response);
}

async function sessionCount(email: string) {
  const { rows } = await h.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM session s JOIN "user" u ON u.id=s."userId" WHERE u.email=$1',
    [email]
  );
  return rows[0].count;
}

beforeAll(async () => {
  h = await startTenancyHarness('account_controls');
  const host = await bootstrapHost(h, 'Owner', OWNER_EMAIL);
  first = host.communityId;
  owner = { cookie: host.cookie, memberId: host.memberId };
  const pending = await createPendingCommunity(h, owner.cookie, 'Second Place');
  second = pending.communityId;
  secondOwner = await claimAsNewAccount(h, pending.token, 'Casey', 'casey@account-controls.test');
  // The same host account also belongs to the second community.
  ownerInSecond = await admit(h, second, secondOwner.cookie, { cookie: owner.cookie });
  neighbour = await admit(h, first, owner.cookie, {
    name: 'Neighbour',
    email: 'neighbour@account-controls.test',
  });
});

afterAll(async () => {
  await h?.close();
});

describe('account controls revoke exactly their stated scope', () => {
  it('disconnects every installation of this account in this community and nothing else', async () => {
    const laptop = await pairInstall(h, first, owner.cookie);
    const desktop = await pairInstall(h, first, owner.cookie, ['read']);
    const ownerElsewhere = await pairInstall(h, second, ownerInSecond.cookie);
    const neighbourInstall = await pairInstall(h, first, neighbour.cookie);
    const otherOwnerInstall = await pairInstall(h, second, secondOwner.cookie);
    for (const [communityId, bearer] of [
      [first, laptop],
      [first, desktop],
      [second, ownerElsewhere],
      [first, neighbourInstall],
      [second, otherOwnerInstall],
    ] as const)
      expect(await installWorks(communityId, bearer)).toBe(200);

    // A wrong password disconnects nothing.
    expect(
      (
        await h.call(`${tenant(first)}/me/grants`, {
          method: 'DELETE',
          cookie: owner.cookie,
          body: { password: 'not-the-password' },
        })
      ).status
    ).toBe(403);
    expect(await installWorks(first, laptop)).toBe(200);
    expect(await installWorks(first, desktop)).toBe(200);

    await expectStatus(
      await h.call(`${tenant(first)}/me/grants`, {
        method: 'DELETE',
        cookie: owner.cookie,
        body: { password: TENANCY_PASSWORD },
      }),
      204,
      'disconnect all'
    );

    // This account's installations in this community stop at once.
    expect(await installWorks(first, laptop)).toBe(401);
    expect(await installWorks(first, desktop)).toBe(401);
    const listed = await (
      await h.call(`${tenant(first)}/me/grants`, { cookie: owner.cookie })
    ).json();
    expect(listed.grants).toEqual([]);
    // The same account's installation in its other community keeps working.
    expect(await installWorks(second, ownerElsewhere)).toBe(200);
    expect(
      (await (await h.call(`${tenant(second)}/me/grants`, { cookie: ownerInSecond.cookie })).json())
        .grants
    ).toHaveLength(1);
    // Other members' installations, here and in the other community, keep working.
    expect(await installWorks(first, neighbourInstall)).toBe(200);
    expect(await installWorks(second, otherOwnerInstall)).toBe(200);
    // Still a member, and this browser is still signed in.
    expect((await h.call(`${tenant(first)}/me`, { cookie: owner.cookie })).status).toBe(200);
    const audit = await h.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_events
       WHERE community_id=$1 AND actor_member_id=$2 AND action='grant.revoke_all'`,
      [first, owner.memberId]
    );
    expect(audit.rows[0].count).toBe(1);
  });

  it('signs one browser out without touching its other browsers, memberships or installations', async () => {
    const install = await pairInstall(h, first, owner.cookie);
    const otherBrowser = await signInAgain(OWNER_EMAIL);
    const before = await sessionCount(OWNER_EMAIL);
    expect(before).toBeGreaterThanOrEqual(2);

    const signedOut = await expectStatus(
      await h.call('/api/auth/sign-out', { cookie: owner.cookie, body: {} }),
      200,
      'sign out'
    );
    // The server ends the session itself (not just the browser's copy) and tells the browser
    // to drop its cookie.
    expect(await sessionCount(OWNER_EMAIL)).toBe(before - 1);
    const cleared = signedOut.headers
      .getSetCookie()
      .filter((cookie) => /session_token=/u.test(cookie));
    expect(cleared.length).toBeGreaterThan(0);
    for (const cookie of cleared) expect(cookie).toMatch(/Max-Age=0/iu);

    // The old cookie, replayed as if the browser had kept it, no longer signs anyone in.
    expect((await h.call('/api/v1/memberships', { cookie: owner.cookie })).status).toBe(401);
    expect((await h.call(`${tenant(first)}/me`, { cookie: owner.cookie })).status).toBe(401);

    // The account's other browser, both memberships and the installation are unchanged.
    const memberships = await h.call('/api/v1/memberships', { cookie: otherBrowser });
    expect(memberships.status).toBe(200);
    expect(
      ((await memberships.json()) as { memberships: { communityId: string }[] }).memberships
        .map((membership) => membership.communityId)
        .sort()
    ).toEqual([first, second].sort());
    expect(await installWorks(first, install)).toBe(200);
    expect((await h.call(`${tenant(first)}/me`, { cookie: neighbour.cookie })).status).toBe(200);
  });
});
