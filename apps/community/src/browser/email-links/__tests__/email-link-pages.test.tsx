// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, refusal, type Reply } from '../../owner-replacement/__tests__/harness.js';
import { AccountBannerSlot, type AccountBanner } from '../AccountBannerSlot.js';
import { ConfirmEmail } from '../ConfirmEmail.js';
import { confirmEmailBanner } from '../ConfirmEmailBanner.js';
import { EmailSignIn } from '../EmailSignIn.js';
import { ForgotPassword } from '../ForgotPassword.js';
import { clearLine, confirmBannerHidden } from '../links.js';
import { ResetPassword } from '../ResetPassword.js';
import { LinkWithPassword } from '../../sign-up/LinkWithPassword.js';

const TOKEN = 'T'.repeat(43);
const PEEK = 'POST /api/v1/email-links/peek';
const ACCESS = [
  'sessions',
  'connections',
  'agent_credentials',
  'pairings',
  'invites',
  'host_api_keys',
];

/** Put a token where the page's inline bootstrap leaves it, as the bootstrap would. */
function captureEmailLink(token: string | null = TOKEN) {
  let secret = token;
  window.__readDorkosEmailLinkFragment = () => secret;
  window.__clearDorkosEmailLinkFragment = () => {
    secret = null;
    delete window.__readDorkosEmailLinkFragment;
    delete window.__clearDorkosEmailLinkFragment;
  };
}

/** The requests that could change something: every POST the page made, in order. */
function posts(calls: { url: string; method: string }[]) {
  return calls.filter((call) => call.method === 'POST').map((call) => call.url);
}

function peek(overrides: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      kind: 'password_reset',
      email: 'me@example.com',
      expiresAt: '2026-10-05T12:00:00.000Z',
      clears: ACCESS,
      needsPassword: false,
      signedInAs: null,
      ...overrides,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__readDorkosEmailLinkFragment;
  delete window.__clearDorkosEmailLinkFragment;
  localStorage.clear();
});

describe('ForgotPassword', () => {
  it('says the same thing whatever the address', async () => {
    // Purpose: fails if the page tells an address with an account from one without.
    const calls = mockFetch({ 'POST /api/v1/account/password-reset': { status: 202 } });
    const said: string[] = [];
    for (const email of ['known@example.com', 'nobody@example.com']) {
      render(<ForgotPassword onBack={() => {}} />);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
      fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
      said.push((await screen.findByRole('status')).textContent ?? '');
      cleanup();
    }
    expect(said[0]).toContain('Check your email. The link works for 30 minutes.');
    expect(said[1]).toBe(said[0]);
    expect(calls.map((call) => call.body)).toEqual([
      { email: 'known@example.com' },
      { email: 'nobody@example.com' },
    ]);
  });

  it('asks a caller over the limit to wait', async () => {
    // Purpose: fails if a 429 shows as a generic failure, or as "sent".
    mockFetch({
      'POST /api/v1/account/password-reset': refusal(429, 'RATE_LIMITED', 'x'),
    });
    render(<ForgotPassword onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(
      await screen.findByText('Too many requests. Wait a minute, then try again.')
    ).toBeTruthy();
  });
});

describe('ResetPassword', () => {
  it('names the account and lists everything the reset ends before the button', async () => {
    // Purpose: fails if a person can reset without seeing whose account it is, that another
    // account is signed in here, or that connections and server API keys end too.
    captureEmailLink();
    const calls = mockFetch({
      [PEEK]: peek({
        clears: [...ACCESS, 'sign_in_links', 'some_future_key'],
        signedInAs: { email: 'other@example.com', method: null },
      }),
      'POST /api/auth/email-link/reset-password': { status: 200, body: { cleared: 'everything' } },
    });
    render(<ResetPassword />);
    expect(await screen.findByText('For me@example.com.')).toBeTruthy();
    expect(
      screen.getByText("You're signed in as other@example.com. This resets me@example.com.")
    ).toBeTruthy();
    for (const line of [
      'Sign-ins on every device',
      'DorkOS connections',
      'Agent keys',
      'Pairings in progress',
      'Invitation links you made',
      'Server API keys you made',
      'Google, GitHub and single sign-on sign-ins',
      // A key this page does not know yet still shows.
      'Other ways in',
    ])
      expect(screen.getByText(line)).toBeTruthy();
    expect(posts(calls)).toEqual(['/api/v1/email-links/peek']);
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'brand-new-password-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByText('Old sign-ins and connections were removed.')).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({
      url: '/api/auth/email-link/reset-password',
      body: { token: TOKEN, newPassword: 'brand-new-password-1' },
    });
  });

  it('says a dead link is dead and offers a new one', async () => {
    // Purpose: fails if an expired or used link shows a form that can never work.
    captureEmailLink();
    mockFetch({ [PEEK]: refusal(410, 'LINK_EXPIRED', 'gone') });
    render(<ResetPassword />);
    expect(await screen.findByText('This link expired or was already used.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forgot password?' })).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });
});

describe('EmailSignIn', () => {
  it('names the account before anything is used (T18)', async () => {
    // Purpose: login CSRF. Fails if the page signs in on load, before the person sees whose
    // account a link someone sent them belongs to.
    captureEmailLink();
    const calls = mockFetch({
      [PEEK]: peek({ kind: 'sign_in', clears: [] }),
      'POST /api/auth/email-link/sign-in': {
        status: 200,
        body: { cleared: false, linked: 'Google' },
      },
    });
    render(<EmailSignIn />);
    expect(await screen.findByText('Sign in as me@example.com?')).toBeTruthy();
    expect(posts(calls)).toEqual(['/api/v1/email-links/peek']);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Google sign-in is now linked.')).toBeTruthy();
  });

  it('warns before clearing a never-confirmed account, and explains a link opened elsewhere', async () => {
    // Purpose: fails if the clean-out is a surprise, or another browser gets a vague error.
    captureEmailLink();
    mockFetch({ [PEEK]: peek({ kind: 'sign_in', clears: [...ACCESS, 'password'] }) });
    render(<EmailSignIn />);
    expect(
      await screen.findByText("Signing in removes this account's old password and other sign-ins.")
    ).toBeTruthy();
    cleanup();
    captureEmailLink();
    mockFetch({ [PEEK]: refusal(410, 'LINK_EXPIRED', 'gone') });
    render(<EmailSignIn />);
    expect(await screen.findByText('Open it in the browser where you asked.')).toBeTruthy();
  });
});

describe('ConfirmEmail', () => {
  it('asks a signed-out browser to sign in, and refuses another account, without posting', async () => {
    // Purpose: fails if the page posts a confirmation the server must refuse, or leaves the
    // person without the one step that would work.
    for (const [signedInAs, words] of [
      [null, 'Sign in, then open this link again.'],
      [
        { email: 'other@example.com', method: null },
        'This link is for another account. Sign in as that account.',
      ],
    ] as const) {
      captureEmailLink();
      const calls = mockFetch({ [PEEK]: peek({ kind: 'email_confirmation', signedInAs }) });
      render(<ConfirmEmail />);
      expect(await screen.findByText(words)).toBeTruthy();
      expect(posts(calls)).toEqual(['/api/v1/email-links/peek']);
      cleanup();
    }
  });

  it('asks for a new password when the account has one, and says other devices were signed out', async () => {
    // Purpose: fails if a never-confirmed account is confirmed without replacing a password a
    // squatter may know, or the person is not told what it ended.
    captureEmailLink();
    const calls = mockFetch({
      [PEEK]: peek({
        kind: 'email_confirmation',
        needsPassword: true,
        signedInAs: { email: 'me@example.com', method: null },
      }),
      'POST /api/v1/account/email-confirmation/confirm': {
        status: 200,
        body: { confirmed: true, cleared: 'others' },
      },
    });
    render(<ConfirmEmail />);
    expect(
      await screen.findByText(
        'Confirming signs out your other devices and ends DorkOS connections.'
      )
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'brand-new-password-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and choose a new password' }));
    expect(await screen.findByText('Other devices were signed out.')).toBeTruthy();
    expect(calls.at(-1)?.body).toEqual({ token: TOKEN, newPassword: 'brand-new-password-1' });
  });

  it('says a dead confirmation link can be sent again from Settings', async () => {
    // Purpose: fails if an expired confirmation dead-ends without the way to a new one.
    captureEmailLink();
    mockFetch({ [PEEK]: refusal(410, 'LINK_EXPIRED', 'gone') });
    render(<ConfirmEmail />);
    expect(await screen.findByText('Send a new one from Settings.')).toBeTruthy();
  });
});

describe('the account banner slot', () => {
  const SESSION = 'GET /api/auth/get-session';
  const METHODS = 'GET /api/v1/account/sign-in-methods';
  const OPTIONS = 'GET /api/v1/auth-options';
  const options = (emailLinks: boolean): Reply => ({
    status: 200,
    body: { google: false, github: false, oidc: null, minimumAge: null, emailLinks },
  });
  const methods = (emailConfirmed: boolean): Reply => ({
    status: 200,
    body: { password: true, oidc: false, emailConfirmed },
  });
  const session: Reply = { status: 200, body: { user: { id: 'account-1' } } };

  it('asks to confirm only where mail is on and the email is not confirmed', async () => {
    // Purpose: fails if the banner shows on a host without mail, or to a confirmed account.
    for (const [emailLinks, confirmed, shown] of [
      [true, false, true],
      [false, false, false],
      [true, true, false],
    ] as const) {
      mockFetch({
        [SESSION]: session,
        [METHODS]: methods(confirmed),
        [OPTIONS]: options(emailLinks),
      });
      render(<AccountBannerSlot banners={[confirmEmailBanner]} />);
      await waitFor(() =>
        expect(
          Boolean(screen.queryByText('Confirm your email so you can always get back in.')),
          `${emailLinks}/${confirmed}`
        ).toBe(shown)
      );
      cleanup();
    }
  });

  it('hides for 30 days per account on Not now, and sends on request', async () => {
    // Purpose: fails if "Not now" does not stick, or sticks for every account in this browser.
    const calls = mockFetch({
      [SESSION]: session,
      [METHODS]: methods(false),
      [OPTIONS]: options(true),
      'POST /api/v1/account/email-confirmation': { status: 202 },
    });
    render(<AccountBannerSlot banners={[confirmEmailBanner]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Confirm your email so you can always get back in.')).toBeNull();
    expect(confirmBannerHidden('account-1')).toBe(true);
    expect(confirmBannerHidden('account-2')).toBe(false);
    expect(confirmBannerHidden('account-1', Date.now() + 31 * 24 * 60 * 60_000)).toBe(false);
    cleanup();
    localStorage.clear();
    render(<AccountBannerSlot banners={[confirmEmailBanner]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send confirmation email' }));
    expect(await screen.findByText('Sent. Open the link while signed in here.')).toBeTruthy();
    expect(calls.some((call) => call.method === 'POST')).toBe(true);
  });

  it('shows at most one banner: the first that applies', async () => {
    // Purpose: fails if two account banners stack, so a later one (DOR-2711) could bury this one.
    mockFetch({ [SESSION]: session, [METHODS]: methods(false), [OPTIONS]: options(true) });
    const first: AccountBanner = {
      id: 'first',
      applies: () => true,
      Banner: () => <p>First banner</p>,
    };
    render(<AccountBannerSlot banners={[first, confirmEmailBanner]} />);
    expect(await screen.findByText('First banner')).toBeTruthy();
    expect(screen.queryByText('Confirm your email so you can always get back in.')).toBeNull();
  });
});

describe('the link-with-password panel with mail', () => {
  const NOTICE = 'GET /api/v1/sign-in-link/notice';
  const pending: Reply = { status: 200, body: { state: 'pending', provider: 'Google' } };
  const options = (emailLinks: boolean): Reply => ({
    status: 200,
    body: { google: true, github: false, oidc: null, minimumAge: null, emailLinks },
  });

  it('offers a sign-in link instead of the password, and for an account with none', async () => {
    // Purpose: fails if an account with no password still dead-ends where the space has mail,
    // or a space without mail offers a link it cannot send.
    const calls = mockFetch({
      [NOTICE]: pending,
      'GET /api/v1/auth-options': options(true),
      'POST /api/v1/sign-in-link': refusal(403, 'PASSWORD_REQUIRED', 'none'),
      'POST /api/v1/sign-in-link/email': { status: 202 },
    });
    render(<LinkWithPassword onCancel={() => {}} onLinked={() => {}} />);
    expect(
      await screen.findByRole('button', { name: 'Email me a sign-in link instead' })
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'guess' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link and sign in' }));
    expect(
      await screen.findByText('This account has no password. Email yourself a sign-in link.')
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(
      await screen.findByText('Check your email. Open the link in this browser within 15 minutes.')
    ).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/v1/sign-in-link/email')).toBe(true);
    cleanup();
    mockFetch({
      [NOTICE]: pending,
      'GET /api/v1/auth-options': options(false),
      'POST /api/v1/sign-in-link': refusal(403, 'PASSWORD_REQUIRED', 'none'),
    });
    render(<LinkWithPassword onCancel={() => {}} onLinked={() => {}} />);
    await screen.findByLabelText('Password');
    expect(screen.queryByRole('button', { name: 'Email me a sign-in link instead' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'guess' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link and sign in' }));
    expect(
      await screen.findByText("This account has no password. Ask the space's owner for help.")
    ).toBeTruthy();
  });
});

describe('the page bootstrap', () => {
  const html = readFileSync(join(import.meta.dirname, '../../index.html'), 'utf8');
  const inline = /<script>([\s\S]*?)<\/script>/u.exec(html)![1];

  it('takes the token out of the address bar on all three pages before anything loads (T20)', () => {
    // Purpose: fails if a mailed link's token stays in the address bar or history, where it
    // could reach a log, a screenshot or a referrer.
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    for (const page of ['/reset-password', '/email-sign-in', '/confirm-email']) {
      window.history.replaceState(null, '', `${page}#${TOKEN}`);
      new Function(inline)();
      expect(window.location.hash).toBe('');
      expect(window.location.pathname).toBe(page);
      expect(window.__readDorkosEmailLinkFragment?.()).toBe(TOKEN);
      window.__clearDorkosEmailLinkFragment?.();
      expect(window.__readDorkosEmailLinkFragment).toBeUndefined();
    }
    window.history.replaceState(null, '', '/');
  });

  it('shows every clears key, known or not', () => {
    // Purpose: fails if a key the server adds later disappears from the list.
    expect(clearLine('host_api_keys')).toBe('Server API keys you made');
    expect(clearLine('other_email_links')).toBe('Other ways in');
  });
});
