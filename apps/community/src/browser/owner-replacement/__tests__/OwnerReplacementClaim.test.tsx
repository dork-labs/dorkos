// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerReplacementClaim } from '../OwnerReplacementClaim.js';
import {
  captureFragment,
  mockFetch,
  refusal,
  spyConsole,
  type Call,
  type Reply,
} from './harness.js';

// The new owner's claim page (specs/community-owner-replacement, "The new owner"): the link is
// exchanged for the server's cookie and forgotten, the page says when the claim opens, asks the
// person to sign in (through the named sign-in service when there is one), confirms, and opens
// Settings. Every refusal is one plain sentence.
const TOKEN = 'claim-token-0a1b2c3d4e5f';
const COMMUNITY = '11111111-1111-4111-8111-111111111111';
const PREFLIGHT = 'POST /api/v1/owner-replacements/preflight';
const CLAIM = 'POST /api/v1/owner-replacements/claim';
const SESSION = 'GET /api/auth/get-session';
const OPTIONS = 'GET /api/v1/auth-options';

function preflight(overrides: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      communityId: COMMUNITY,
      communityName: 'Acme Ops',
      state: 'claimable',
      claimableAfter: '2026-10-04T10:00:00.000Z',
      claimExpiresAt: '2026-10-18T10:00:00.000Z',
      requiresSingleSignOn: false,
      ...overrides,
    },
  };
}
const signedIn: Reply = { status: 200, body: { user: { name: 'Riley', email: 'riley@new.test' } } };
const noSso: Reply = {
  status: 200,
  body: { google: false, github: false, oidc: null, minimumAge: null },
};
const sso: Reply = {
  status: 200,
  body: { google: false, github: false, oidc: { label: 'Example sign-in' }, minimumAge: null },
};

let consoleText: () => string;
let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.history.replaceState(null, '', '/owner-replacement');
  sessionStorage.clear();
  consoleText = spyConsole();
  assign = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    origin: window.location.origin,
    pathname: '/owner-replacement',
    search: '',
    href: `${window.location.origin}/owner-replacement`,
    assign,
  } as unknown as Location);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.__clearDorkosOwnerReplacementFragment?.();
});

/** The requests about the claim, leaving out the page's own sign-in and policy reads. */
function claimCalls(calls: Call[]) {
  return calls
    .filter((call) => call.url.includes('/owner-replacements/'))
    .map((call) => ({ route: `${call.method} ${call.url}`, body: call.body }));
}

function expectTokenContained(calls: Call[]) {
  expect(window.location.search).not.toContain(TOKEN);
  expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true);
  expect(consoleText()).not.toContain(TOKEN);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
}

async function reachConfirm(claim: Reply | ((call: Call) => Reply)) {
  captureFragment(TOKEN);
  const calls = mockFetch({
    [PREFLIGHT]: preflight(),
    [SESSION]: signedIn,
    [OPTIONS]: noSso,
    [CLAIM]: claim,
  });
  render(<OwnerReplacementClaim />);
  fireEvent.click(await screen.findByRole('button', { name: /^Take ownership/u }));
  await screen.findByRole('dialog', { name: 'Take ownership of Acme Ops?' });
  return calls;
}

describe('OwnerReplacementClaim, before the date', () => {
  it('says the date and to keep the link, and offers nothing to press', async () => {
    // Purpose: fails if a waiting claim offers sign-in or Take ownership, or the fragment copy
    // outlives the preflight.
    captureFragment(TOKEN);
    const calls = mockFetch({ [PREFLIGHT]: preflight({ state: 'waiting' }), [OPTIONS]: noSso });
    render(<OwnerReplacementClaim />);
    expect(
      await screen.findByText(
        'You can take ownership of Acme Ops on or after Sunday, 4 October 2026 (UTC). Keep this link.'
      )
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Take ownership|Create account|Sign in/u })
    ).toBeNull();
    expect(claimCalls(calls)).toEqual([{ route: PREFLIGHT, body: { token: TOKEN } }]);
    expect(window.__readDorkosOwnerReplacementFragment).toBeUndefined();
    expectTokenContained(calls);
  });

  it('says the wait has not started while the owner is still being told', async () => {
    // Purpose: fails if a claim with no date yet shows a blank or invalid date.
    captureFragment(TOKEN);
    mockFetch({
      [PREFLIGHT]: preflight({ state: 'notifying', claimableAfter: null, claimExpiresAt: null }),
      [OPTIONS]: noSso,
    });
    render(<OwnerReplacementClaim />);
    expect(
      await screen.findByText(
        'You can’t take ownership of Acme Ops yet. The waiting period starts once the owner has been told. Keep this link.'
      )
    ).toBeTruthy();
  });
});

describe('OwnerReplacementClaim, at the date', () => {
  it('confirms, calls the claim route, and opens Settings', async () => {
    // Purpose: fails if Take ownership claims without the confirm, calls another route, or
    // does not open the community's Settings afterwards.
    const calls = await reachConfirm({
      status: 200,
      body: { community: { id: COMMUNITY, name: 'Acme Ops' }, memberId: COMMUNITY },
    });
    expect(
      screen.getByText('You’ll become the owner of Acme Ops. The current owner stays a member.')
    ).toBeTruthy();
    expect(claimCalls(calls)).toEqual([{ route: PREFLIGHT, body: { token: TOKEN } }]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Take ownership' }).at(-1)!);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/c/${COMMUNITY}/settings`));
    expect(claimCalls(calls)).toEqual([
      { route: PREFLIGHT, body: { token: TOKEN } },
      { route: CLAIM, body: {} },
    ]);
    expect(sessionStorage.length).toBe(0);
    expectTokenContained(calls);
  });

  it.each([
    [403, 'FORBIDDEN', 'Sign in with the account named in the request, then try again.'],
    [
      409,
      'STATE_CONFLICT',
      "This host's sign-in service changed, so this claim can't be used. Ask the host for a new request.",
    ],
    [409, 'STATE_CONFLICT', 'You already own this community.'],
    [409, 'STATE_CONFLICT', "This account is being deleted, so it can't take ownership."],
  ])('says the %s refusal in one sentence and stays on the page', async (status, code, message) => {
    // Purpose: fails if a refusal the person can act on is hidden or turned into a dead end.
    await reachConfirm(refusal(status, code, message));
    fireEvent.click(screen.getAllByRole('button', { name: 'Take ownership' }).at(-1)!);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use a different account' })).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('turns an unavailable claim into its own page and forgets the resume marker', async () => {
    // Purpose: fails if a claim that can never work leaves a retry button or a stale marker.
    await reachConfirm(refusal(403, 'FORBIDDEN', 'This ownership claim is unavailable.'));
    expect(sessionStorage.length).toBe(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Take ownership' }).at(-1)!);
    expect(
      await screen.findByRole('heading', { name: 'This ownership claim is unavailable.' })
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Take ownership/u })).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('says a dead link is unavailable without asking about an account', async () => {
    // Purpose: fails if the preflight refusal leads anywhere but the unavailable page.
    captureFragment(TOKEN);
    const calls = mockFetch({
      [PREFLIGHT]: refusal(403, 'FORBIDDEN', 'This ownership claim is unavailable.'),
      [OPTIONS]: noSso,
    });
    render(<OwnerReplacementClaim />);
    expect(
      await screen.findByRole('heading', { name: 'This ownership claim is unavailable.' })
    ).toBeTruthy();
    expect(calls.some((call) => call.url.includes('get-session'))).toBe(false);
    expectTokenContained(calls);
  });

  it('asks a signed-out person to sign in or create an account on a host without single sign-on', async () => {
    // Purpose: fails if the password form is missing where the request names no account.
    captureFragment(TOKEN);
    mockFetch({
      [PREFLIGHT]: preflight(),
      [SESSION]: { status: 200, body: null },
      [OPTIONS]: noSso,
    });
    render(<OwnerReplacementClaim />);
    expect(
      await screen.findByText('Sign in, or create an account on this host, to take ownership.')
    ).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
  });

  it('offers only the named sign-in service when the request names an account', async () => {
    // Purpose: fails if a password form is offered where only the named account can claim.
    captureFragment(TOKEN);
    mockFetch({
      [PREFLIGHT]: preflight({ requiresSingleSignOn: true }),
      [SESSION]: { status: 200, body: null },
      [OPTIONS]: sso,
    });
    render(<OwnerReplacementClaim />);
    expect(
      await screen.findByText(
        'Sign in, or create your account, with Example sign-in. Only the account named in the request can take ownership.'
      )
    ).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: 'Continue with Example sign-in' })
    ).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('keeps the named sign-in service off until a new account confirms the minimum age', async () => {
    // Purpose: fails if a person can start creating an account through the sign-in service
    // without the age confirmation the host asks for, as the owner claim page already forbids.
    captureFragment(TOKEN);
    mockFetch({
      [PREFLIGHT]: preflight({ requiresSingleSignOn: true }),
      [SESSION]: { status: 200, body: null },
      [OPTIONS]: {
        status: 200,
        body: { google: false, github: false, oidc: { label: 'Example sign-in' }, minimumAge: 16 },
      },
    });
    render(<OwnerReplacementClaim />);
    const button = (await screen.findByRole('button', {
      name: 'Continue with Example sign-in',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('I am at least 16 years old.'));
    expect(button.disabled).toBe(false);
  });

  it('resumes after a sign-in round trip from the marker, which never holds the token', async () => {
    // Purpose: fails if returning from the sign-in service loses the claim, or if the marker
    // that makes that possible carries the secret.
    captureFragment(TOKEN);
    const first = mockFetch({
      [PREFLIGHT]: preflight({ requiresSingleSignOn: true }),
      [SESSION]: { status: 200, body: null },
      [OPTIONS]: sso,
    });
    const page = render(<OwnerReplacementClaim />);
    await screen.findByRole('button', { name: 'Continue with Example sign-in' });
    expectTokenContained(first);
    page.unmount();

    const back = mockFetch({ [SESSION]: signedIn, [OPTIONS]: sso });
    render(<OwnerReplacementClaim />);
    expect(await screen.findByRole('button', { name: /^Take ownership/u })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Take ownership of Acme Ops' })).toBeTruthy();
    expect(claimCalls(back)).toEqual([]);
  });

  it('asks for the link when opened without one', async () => {
    // Purpose: fails if the page guesses a claim or calls a claim route with nothing to send.
    const calls = mockFetch({ [OPTIONS]: noSso });
    render(<OwnerReplacementClaim />);
    expect(await screen.findByRole('heading', { name: 'Open your ownership link' })).toBeTruthy();
    expect(claimCalls(calls)).toEqual([]);
  });
});
