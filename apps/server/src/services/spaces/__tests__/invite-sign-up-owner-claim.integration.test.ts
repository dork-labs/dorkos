import { afterAll, beforeAll, expect, it } from 'vitest';
import { emailLinkComposers } from '../email-links/composers.js';
import {
  bootstrapHost,
  createPendingCommunity,
  expectStatus,
  preflightOwnerClaim,
  startTenancyHarness,
  TENANCY_PASSWORD,
  type TenancyHarness,
} from './tenancy-test-harness.js';

// DOR-2730, Security S5: only an invitation's sign-up answers by email. An owner claim, held by
// one person, keeps Better Auth's password sign-up on a host that mails links, and is signed
// straight in (so for that path a taken address still answers 422, as documented). Its own
// database, because creating a second space changes which space a host's routes default to.
let h: TenancyHarness;

beforeAll(async () => {
  h = await startTenancyHarness('invite_owner_claim', {
    env: {
      // Mail is set up so the host mails links; nothing in this test sends any.
      COMMUNITY_SMTP_URL: 'smtp://127.0.0.1:9',
      COMMUNITY_MAIL_FROM: 'Test Space <spaces@community.test>',
    },
    noticeComposers: emailLinkComposers({
      publicUrl: 'http://localhost:6481',
      authSecret: 'a'.repeat(32),
    }),
  });
});

afterAll(async () => {
  await h?.close();
});

it('leaves an owner claim on the password sign-up it had, with mail on', async () => {
  // Fails if the email-only sign-up takes over an owner claim: the claimer would get no session.
  const operator = await bootstrapHost(h, 'Operator', 'operator@claim.test');
  const { token } = await createPendingCommunity(h, operator.cookie, 'Claimed');
  const grant = await preflightOwnerClaim(h, token);
  const signedUp = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      body: { name: 'Claimer', email: 'claimer@claim.test', password: TENANCY_PASSWORD },
      cookie: grant,
    }),
    200,
    'owner-claim sign-up'
  );
  expect(((await signedUp.json()) as { token: string | null }).token).toEqual(expect.any(String));
});
