// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Admission } from '../components/Admission.js';
import type { Community } from '../types.js';
import { OwnerClaim } from '../components/OwnerClaim.js';
import { Pairing } from '../components/Pairing.js';
import { mockFetch, type Reply } from '../owner-replacement/__tests__/harness.js';

// Each page builds its Better Auth client as it loads; the provider round trip is the browser
// leaving for the issuer, so the test stops at the call that would start it.
const signInSocial = vi.hoisted(() =>
  vi.fn(async (_options: { provider: string }) => ({ error: null }))
);
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({ signIn: { social: signInSocial }, linkSocial: vi.fn() }),
}));

// The single sign-on hint (`?sign-in=single-sign-on`): the DorkOS app adds it where the person's
// DorkOS account is this host's single sign-on, so an owner claim, an invitation and a
// connection approval lead with that sign-in and nobody makes a second account. Without the
// hint, or on a host with no single sign-on, each page is exactly what it always was.
const HINT = '?sign-in=single-sign-on';
const OPTIONS = 'GET /api/v1/auth-options';
const AGE = 'POST /api/v1/age-confirmation';

function options(overrides: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      google: false,
      github: false,
      oidc: { label: 'DorkOS' },
      minimumAge: null,
      ...overrides,
    },
  };
}
const noSso = options({ oidc: null });

/** Open the page at this address, as the browser would have loaded it. */
function at(path: string) {
  window.history.replaceState(null, '', path);
}

/** Whether an element is folded away under a closed "Other ways to sign in". */
function folded(element: Element): boolean {
  const details = element.closest('details');
  return details !== null && !details.open;
}

afterEach(() => {
  cleanup();
  signInSocial.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('the connection approval page', () => {
  const pairing = { status: 401, body: { code: 'UNAUTHENTICATED', message: 'Sign in.' } };

  it('leads with the host’s single sign-on when opened with the hint, and folds the rest', async () => {
    // Purpose: fails if a DorkOS-run space asks for a password first, or loses the other ways.
    mockFetch({ [OPTIONS]: options(), 'GET /api/v1/pairings/p_1': pairing });
    render(<Pairing search={`?pairingId=p_1&${HINT.slice(1)}`} />);
    const lead = await screen.findByRole('button', { name: 'Continue with DorkOS' });
    await waitFor(() => expect(document.activeElement).toBe(lead));
    expect(folded(screen.getByLabelText('Email'))).toBe(true);
    expect(screen.getByText('Other ways to sign in').tagName).toBe('SUMMARY');
    // One button for the single sign-on, not a second one among the other ways.
    expect(screen.getAllByRole('button', { name: 'Continue with DorkOS' })).toHaveLength(1);
    fireEvent.click(lead);
    await waitFor(() => expect(signInSocial).toHaveBeenCalledTimes(1));
    expect(signInSocial.mock.calls[0]?.[0]).toMatchObject({ provider: 'oidc' });
  });

  it('is the password form it always was without the hint', async () => {
    mockFetch({ [OPTIONS]: options(), 'GET /api/v1/pairings/p_1': pairing });
    render(<Pairing search="?pairingId=p_1" />);
    expect(folded(await screen.findByLabelText('Email'))).toBe(false);
    await screen.findByRole('button', { name: 'Continue with DorkOS' });
    expect(screen.queryByText('Other ways to sign in')).toBeNull();
  });

  it('ignores the hint on a host with no single sign-on', async () => {
    // Purpose: a self-run space keeps its own accounts whatever link it is opened with.
    mockFetch({ [OPTIONS]: noSso, 'GET /api/v1/pairings/p_1': pairing });
    render(<Pairing search={`?pairingId=p_1&${HINT.slice(1)}`} />);
    await waitFor(() => expect(folded(screen.getByLabelText('Email'))).toBe(false));
    expect(screen.queryByText('Other ways to sign in')).toBeNull();
    expect(screen.queryByRole('button', { name: /Continue with/u })).toBeNull();
  });
});

describe('the owner claim page', () => {
  const TOKEN = 'claim-token-0a1b2c3d';
  const routes = (extra: Record<string, Reply> = {}) => ({
    'POST /api/v1/owner-claims/preflight': {
      status: 200,
      body: { granted: true, communityId: 'c_1', expiresAt: '2099-01-01T00:00:00.000Z' },
    },
    'GET /api/auth/get-session': { status: 200, body: null },
    [AGE]: { status: 200, body: { confirmed: true, expiresAt: '2099-01-01T00:00:00.000Z' } },
    ...extra,
  });

  function withClaimFragment() {
    let secret: string | null = TOKEN;
    window.__readDorkosOwnerClaimFragment = () => secret;
    window.__clearDorkosOwnerClaimFragment = () => {
      secret = null;
    };
  }

  it('claims with the single sign-on, confirming the minimum age first', async () => {
    // Purpose: fails if starting a DorkOS-run space asks for a second account, or if the
    // single sign-on can make an account without the host's age confirmation.
    at(`/claim${HINT}`);
    withClaimFragment();
    const calls = mockFetch(routes({ [OPTIONS]: options({ minimumAge: 16 }) }));
    render(<OwnerClaim />);
    fireEvent.click(await screen.findByRole('button', { name: /Continue/u }));
    const lead = await screen.findByRole('button', { name: 'Continue with DorkOS' });
    expect(folded(screen.getByText('Sign in with DorkOS to claim the community.'))).toBe(false);
    expect(folded(screen.getByLabelText('Your name'))).toBe(true);
    expect((lead as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect((lead as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(lead);
    await waitFor(() => expect(signInSocial).toHaveBeenCalledTimes(1));
    // The age was confirmed before the round trip that may make the account began.
    const age = calls.findIndex((call) => `${call.method} ${call.url}` === AGE);
    expect(age).toBeGreaterThan(-1);
    expect(vi.mocked(fetch).mock.invocationCallOrder[age]).toBeLessThan(
      signInSocial.mock.invocationCallOrder[0]!
    );
    expect(signInSocial.mock.calls[0]?.[0]).toMatchObject({ provider: 'oidc' });
  });

  it('offers the sign-up form first without the hint', async () => {
    at('/claim');
    withClaimFragment();
    mockFetch(routes({ [OPTIONS]: options() }));
    render(<OwnerClaim />);
    fireEvent.click(await screen.findByRole('button', { name: /Continue/u }));
    expect(folded(await screen.findByLabelText('Your name'))).toBe(false);
    expect(
      folded(
        screen.getByText('Create an account on this host, or sign in, to claim the community.')
      )
    ).toBe(false);
    expect(screen.queryByText('Other ways to sign in')).toBeNull();
  });
});

describe('the invitation page', () => {
  const pending = {
    kind: 'pending' as const,
    pending: {
      expiresAt: '2099-01-01T00:00:00.000Z',
      communityName: 'Night shift',
      inviterName: 'Riley',
      channelName: null,
      account: null,
    },
  };
  const community: Community = {
    id: 'c_1',
    name: 'Night shift',
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const props = {
    community,
    inviteToken: null,
    unadmitted: false,
    onAdmitted: () => {},
    onInviteExchanged: () => {},
    resume: pending,
  };

  it('joins with the single sign-on and says no separate account is needed', async () => {
    // Purpose: fails if joining a DorkOS-run space leads with "Create an account on this host",
    // or hides which community the invitation is for behind the fold.
    at(`/join${HINT}`);
    mockFetch({ [OPTIONS]: options() });
    render(<Admission {...props} />);
    const lead = await screen.findByRole('button', { name: 'Continue with DorkOS' });
    expect(
      folded(screen.getByText('Continue with DorkOS. You don’t need a separate account here.'))
    ).toBe(false);
    expect(folded(screen.getByText(/Night shift/u))).toBe(false);
    expect(folded(screen.getByLabelText('Email'))).toBe(true);
    fireEvent.click(lead);
    await waitFor(() => expect(signInSocial).toHaveBeenCalledTimes(1));
    expect(signInSocial.mock.calls[0]?.[0]).toMatchObject({ provider: 'oidc' });
  });

  it('is the account form it always was without the hint', async () => {
    at('/join');
    mockFetch({ [OPTIONS]: options() });
    render(<Admission {...props} />);
    expect(folded(await screen.findByLabelText('Email'))).toBe(false);
    expect(
      folded(
        screen.getByText('Create an account on this host, or sign in if you already have one.')
      )
    ).toBe(false);
    expect(screen.queryByText('Other ways to sign in')).toBeNull();
  });

  it('keeps the sign-in buttons on the not-joined panel, with or without the hint', async () => {
    // Purpose: fails if a signed-in account that has not joined loses the provider buttons it
    // always had there (the panel must be exactly what it was before the hint existed).
    for (const path of ['/join', `/join${HINT}`]) {
      at(path);
      mockFetch({ [OPTIONS]: options() });
      render(<Admission {...props} resume={null} unadmitted />);
      expect(await screen.findByText('Your account has not joined yet.')).toBeTruthy();
      expect(await screen.findByRole('button', { name: 'Continue with DorkOS' })).toBeTruthy();
      expect(screen.queryByText('Other ways to sign in')).toBeNull();
      cleanup();
    }
  });

  it('promises no separate account when signing in without an invitation', async () => {
    // Purpose: fails if a plain sign-in page (no invitation read) says nobody needs an account.
    at(`/join${HINT}`);
    mockFetch({ [OPTIONS]: options() });
    render(<Admission {...props} resume={null} />);
    expect(await screen.findByText('Continue with DorkOS.')).toBeTruthy();
    expect(screen.queryByText(/separate account/u)).toBeNull();
  });
});
