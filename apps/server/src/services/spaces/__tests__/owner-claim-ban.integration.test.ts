import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  createPendingCommunity,
  expectStatus,
  preflightOwnerClaim,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

// DOR-2764: a ban an import carried into an unclaimed space still holds at its owner claim.
let h: TenancyHarness;
let operatorCookie = '';

beforeAll(async () => {
  h = await startTenancyHarness('ownerclaimban');
  operatorCookie = (await bootstrapHost(h, 'Olive Host', 'olive@owner-claim-ban.test')).cookie;
});

afterAll(async () => {
  await h?.close();
});

it('refuses an owner claim by a banned account, and takes it once the ban is lifted', async () => {
  // Purpose: fails if a banned person can come back as the owner of an unclaimed space.
  const { communityId, token } = await createPendingCommunity(h, operatorCookie, 'Banned Claim');
  const grant = await preflightOwnerClaim(h, token);
  const signedUp = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      body: { name: 'Bo', email: 'bo@owner-claim-ban.test', password: TENANCY_PASSWORD },
      cookie: grant,
    }),
    200,
    'sign up'
  );
  const cookie = `${grant}; ${signedUp.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')}`;
  const user = await h.pool.query<{ id: string }>(
    `SELECT id FROM "user" WHERE email='bo@owner-claim-ban.test'`
  );
  const ban = await h.pool.query<{ id: string }>(
    `INSERT INTO bans(community_id,user_id,origin) VALUES($1,$2,'imported') RETURNING id`,
    [communityId, user.rows[0].id]
  );
  const refused = await h.call('/api/v1/owner-claims/claim', { cookie, body: {} });
  expect(refused.status).toBe(403);
  const owner = await h.pool.query('SELECT 1 FROM members WHERE community_id=$1', [communityId]);
  expect(owner.rowCount).toBe(0);
  await h.pool.query('UPDATE bans SET lifted_at=now() WHERE id=$1', [ban.rows[0].id]);
  const again = await preflightOwnerClaim(h, token);
  const claimed = await h.call('/api/v1/owner-claims/claim', {
    cookie: `${cookie}; ${again}`,
    body: {},
  });
  expect(claimed.status).toBe(200);
});
