import { describe, expect, it } from 'vitest';
import { clearsFor, emailLinksOn, EMAIL_LINK_NOTICE_KIND } from '../model.js';
import { emailLinkComposers, emailLinkMail } from '../composers.js';

const URL = 'https://space.example';
const LINK = `${URL}/reset-password#${'t'.repeat(43)}`;

describe('emailLinkMail', () => {
  it('writes each kind as spec §8 says, with a one-line subject and the link once', () => {
    // Purpose: fails if a subject could carry a line break, a body drops the link or its lifetime,
    // or the copy drifts from the reviewed wording.
    const reset = emailLinkMail('password_reset', URL, LINK);
    expect(reset.subject).toBe('Reset your password for space.example');
    expect(reset.text).toBe(
      [
        `Someone asked to reset the password for your account at ${URL}.`,
        `To choose a new password, open this link within 30 minutes: ${LINK}`,
        'Resetting signs out every device and ends DorkOS connections, agent keys, invitation links and server API keys.',
        "If you didn't ask, ignore this email. Your password stays the same.",
      ].join('\n\n') + '\n'
    );
    const signIn = emailLinkMail('sign_in', URL, LINK);
    expect(signIn.subject).toBe('Your sign-in link for space.example');
    expect(signIn.text).toContain('within 15 minutes');
    expect(signIn.text).toContain('only in the browser where you asked for it');
    const confirm = emailLinkMail('email_confirmation', URL, LINK);
    expect(confirm.subject).toBe('Confirm your email for space.example');
    expect(confirm.text).toContain('while signed in, within 24 hours');
    for (const mail of [reset, signIn, confirm]) {
      expect(mail.subject).not.toMatch(/[\r\n]/u);
      expect(mail.text.split(LINK)).toHaveLength(2);
    }
  });
});

describe('emailLinksOn', () => {
  it('is on only with mail set up and all three composers registered', () => {
    // Purpose: fails if a host without mail, or a worker missing a composer, offers links whose
    // mail could never be composed.
    const composers = emailLinkComposers({ publicUrl: URL, authSecret: 'a'.repeat(32) });
    const mail = { smtp: {}, from: {} } as never;
    expect(emailLinksOn({ mail }, composers)).toBe(true);
    expect(emailLinksOn({ mail: null }, composers)).toBe(false);
    const missing = { ...composers };
    delete missing[EMAIL_LINK_NOTICE_KIND.sign_in];
    expect(emailLinksOn({ mail }, missing)).toBe(false);
  });
});

describe('clearsFor', () => {
  it('lists what each use ends, by account state', () => {
    // Purpose: fails if a page could under-state what a link ends before the person submits.
    const access = [
      'sessions',
      'connections',
      'agent_credentials',
      'pairings',
      'invites',
      'host_api_keys',
    ];
    expect(clearsFor('password_reset', true)).toEqual(access);
    expect(clearsFor('password_reset', false)).toEqual([...access, 'password', 'sign_in_links']);
    expect(clearsFor('sign_in', true)).toEqual([]);
    expect(clearsFor('sign_in', false)).toEqual([...access, 'password', 'sign_in_links']);
    expect(clearsFor('email_confirmation', true)).toEqual([]);
    expect(clearsFor('email_confirmation', false)).toEqual([
      ...access,
      'password',
      'sign_in_links',
    ]);
  });
});
