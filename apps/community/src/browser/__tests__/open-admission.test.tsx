// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAdmission } from '../components/OpenAdmission.js';
import { mockFetch, refusal, type Reply } from '../owner-replacement/__tests__/harness.js';

// The provider round trip is the browser leaving for the issuer, so the test stops at the call.
const signInSocial = vi.hoisted(() =>
  vi.fn(async (_options: { provider: string }) => ({ error: null }))
);
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({ signIn: { social: signInSocial }, linkSocial: vi.fn() }),
}));

const community = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'DorkOS Community',
  description: null,
  createdAt: '2026-10-07T00:00:00.000Z',
};
const OPTIONS = 'GET /api/v1/auth-options';
const PREFLIGHT = 'POST /api/v1/open-admission/preflight';
const JOIN = 'POST /api/v1/open-admission/join';
const NOTE = `dorkos-open-join:${community.id}`;

function options(minimumAge: number | null = null): Reply {
  return {
    status: 200,
    body: {
      google: true,
      github: false,
      oidc: { label: 'DorkOS', mark: 'dorkos' },
      minimumAge,
      emailLinks: false,
    },
  };
}
const preflight: Reply = {
  status: 200,
  body: { granted: true, expiresAt: '2026-10-07T00:10:00.000Z' },
};

afterEach(() => {
  cleanup();
  signInSocial.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('the join page of an open space', () => {
  it('offers only the single sign-on, and joins nothing until it is clicked', async () => {
    // Purpose: fails if the page offers a password sign-up, another provider, or joins silently.
    const calls = mockFetch({ [OPTIONS]: options(), [PREFLIGHT]: preflight });
    render(
      <OpenAdmission
        community={community}
        signedIn={false}
        onAdmitted={vi.fn()}
        onOtherWays={vi.fn()}
      />
    );
    expect(screen.getByRole('heading', { name: 'Join DorkOS Community' })).toBeTruthy();
    const button = await screen.findByRole('button', { name: 'Continue with DorkOS' });
    expect(screen.queryByRole('button', { name: /Google/u })).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(signInSocial).toHaveBeenCalledTimes(1));
    expect(signInSocial.mock.calls[0]?.[0]).toMatchObject({ provider: 'oidc' });
    expect(
      calls.map((call) => call.method + ' ' + new URL(call.url, 'http://x').pathname)
    ).toContain(PREFLIGHT);
    expect(window.sessionStorage.getItem(NOTE)).toBe('1');
  });

  it('asks a new account to confirm the minimum age first', async () => {
    // Purpose: fails if open joining skips the host's age check on the way to a new account.
    mockFetch({ [OPTIONS]: options(16), [PREFLIGHT]: preflight });
    render(
      <OpenAdmission
        community={community}
        signedIn={false}
        onAdmitted={vi.fn()}
        onOtherWays={vi.fn()}
      />
    );
    const button = await screen.findByRole('button', { name: 'Continue with DorkOS' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('I am at least 16 years old.'));
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('finishes the join it was asked for after the sign-in returns, once', async () => {
    // Purpose: fails if the return from single sign-on does not complete the join, or if a
    // signed-in visit without that click joins anyway.
    window.sessionStorage.setItem(NOTE, '1');
    const onAdmitted = vi.fn();
    const calls = mockFetch({
      [OPTIONS]: options(),
      [JOIN]: { status: 200, body: { memberId: community.id } },
    });
    render(
      <OpenAdmission community={community} signedIn onAdmitted={onAdmitted} onOtherWays={vi.fn()} />
    );
    await waitFor(() => expect(onAdmitted).toHaveBeenCalledTimes(1));
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(window.sessionStorage.getItem(NOTE)).toBeNull();
    cleanup();

    const quiet = mockFetch({ [OPTIONS]: options() });
    render(
      <OpenAdmission community={community} signedIn onAdmitted={vi.fn()} onOtherWays={vi.fn()} />
    );
    await screen.findByRole('button', { name: 'Continue with DorkOS' });
    expect(quiet.some((call) => call.method === 'POST')).toBe(false);
  });

  it('says why a banned account cannot join', async () => {
    // Purpose: fails if a refused join leaves the page spinning or silent.
    window.sessionStorage.setItem(NOTE, '1');
    mockFetch({
      [OPTIONS]: options(),
      [JOIN]: refusal(403, 'FORBIDDEN', "You can't join this space."),
    });
    render(
      <OpenAdmission community={community} signedIn onAdmitted={vi.fn()} onOtherWays={vi.fn()} />
    );
    expect((await screen.findByRole('alert')).textContent).toContain("You can't join this space.");
  });

  it('lets an existing member sign in another way', async () => {
    // Purpose: fails if a member whose account has a password is locked out of an open space.
    mockFetch({ [OPTIONS]: options() });
    const onOtherWays = vi.fn();
    render(
      <OpenAdmission
        community={community}
        signedIn={false}
        onAdmitted={vi.fn()}
        onOtherWays={onOtherWays}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in another way' }));
    expect(onOtherWays).toHaveBeenCalledTimes(1);
  });
});
