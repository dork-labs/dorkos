import { describe, expect, it } from 'vitest';
import { openAccountCreationRefusal, openPasswordSignUpRefusal } from '../auth.js';
import {
  OPEN_ADMISSION_COOKIE,
  openAdmissionValue,
  readOpenAdmission,
} from '../admission/open-admission-cookie.js';
import { signValue } from '../security.js';
import type { CommunityConfig } from '../config.js';

const COMMUNITY = '00000000-0000-4000-8000-000000000001';
const open = { by: 'open', communityId: COMMUNITY } as const;
const invited = { by: 'grant', communityId: COMMUNITY } as const;
const config = { authSecret: 'a'.repeat(32) } as CommunityConfig;

// Each of an open space's two password gates is pinned on its own: together they hide each
// other's removal, so an end-to-end test alone cannot tell that one of them is gone.
describe('the first gate: the sign-up endpoints', () => {
  it('refuses a password sign-up that an open-space click admitted', () => {
    // Purpose: fails if the sign-up endpoint lets an open-space cookie make a password account.
    expect(openPasswordSignUpRefusal(open)?.body?.code).toBe('single_sign_on_required');
  });

  it('leaves an invitation alone', () => {
    expect(openPasswordSignUpRefusal(invited)).toBeNull();
  });
});

describe('the second gate: where every account is created', () => {
  it('refuses any creation for an open space but the single sign-on callback', () => {
    // Purpose: fails if Google, GitHub, or a path the first gate never sees makes an account
    // for an open space.
    for (const ctx of [
      undefined,
      { path: '/sign-up/email' },
      { path: '/callback/google' },
      { path: '/callback/:id', params: { id: 'github' } },
    ])
      expect(openAccountCreationRefusal(open, ctx)?.body?.code).toBe('single_sign_on_required');
  });

  it('admits the single sign-on callback, and never touches an invitation', () => {
    expect(openAccountCreationRefusal(open, { path: '/callback/oidc' })).toBeNull();
    expect(
      openAccountCreationRefusal(open, { path: '/callback/:id', params: { id: 'oidc' } })
    ).toBeNull();
    expect(openAccountCreationRefusal(invited, { path: '/sign-up/email' })).toBeNull();
  });
});

describe('the open-admission cookie', () => {
  const cookie = (value: string) => `${OPEN_ADMISSION_COOKIE}=${encodeURIComponent(value)}`;

  it('names its community until it expires', () => {
    const later = new Date(Date.now() + 60_000);
    expect(
      readOpenAdmission(
        cookie(signValue(openAdmissionValue(COMMUNITY, later), config.authSecret)),
        config
      )
    ).toBe(COMMUNITY);
    const past = new Date(Date.now() - 1);
    expect(
      readOpenAdmission(
        cookie(signValue(openAdmissionValue(COMMUNITY, past), config.authSecret)),
        config
      )
    ).toBeNull();
  });

  it('refuses a value signed for another purpose', () => {
    // Purpose: fails if a value this server signs for another cookie, without the prefix, could
    // pass as an open-admission click.
    const bare = `${COMMUNITY}.${Date.now() + 60_000}`;
    expect(readOpenAdmission(cookie(signValue(bare, config.authSecret)), config)).toBeNull();
    expect(
      readOpenAdmission(
        cookie(
          signValue(openAdmissionValue(COMMUNITY, new Date(Date.now() + 60_000)), 'b'.repeat(32))
        ),
        config
      )
    ).toBeNull();
  });
});
