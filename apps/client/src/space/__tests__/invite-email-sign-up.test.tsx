// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Admission } from '../components/Admission.js';
import { takeJoinPath } from '../admission.js';
import type { Community } from '../types.js';
import { mockFetch, type Reply } from '../owner-replacement/__tests__/harness.js';

vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({ signIn: { social: vi.fn() }, linkSocial: vi.fn() }),
}));

// DOR-2730: on a space that mails links, an invitation's sign-up asks for a name and an email
// only, then shows the same "Check your email" for every address. The mailed link sets the
// password. A space that mails nothing keeps the password form.
const OPTIONS = 'GET /api/v1/auth-options';
const SIGN_UP = 'POST /api/auth/sign-up/email';
const RESEND = 'POST /api/v1/account/password-reset';

const options = (emailLinks: boolean): Reply => ({
  status: 200,
  body: { google: false, github: false, oidc: null, minimumAge: null, emailLinks },
});
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
  resume: {
    kind: 'pending' as const,
    pending: {
      expiresAt: '2099-01-01T00:00:00.000Z',
      communityName: 'Night shift',
      inviterName: 'Riley',
      channelName: null,
      account: null,
    },
  },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function signUp() {
  const calls = mockFetch({
    [OPTIONS]: options(true),
    [SIGN_UP]: { status: 200, body: { token: null, user: {} } },
    [RESEND]: { status: 202, body: { accepted: true } },
  });
  render(<Admission {...props} />);
  const email = await screen.findByLabelText('Email');
  await waitFor(() => expect(screen.queryByLabelText('Password')).toBeNull());
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sam' } });
  fireEvent.change(email, { target: { value: 'sam@example.com' } });
  const next = screen.getByRole('button', { name: /Continue/u });
  // No key icon: this form has no password.
  expect(next.querySelector('svg')).toBeNull();
  fireEvent.click(next);
  await screen.findByRole('heading', { name: 'Check your email' });
  return calls;
}

describe("an invitation's sign-up", () => {
  it('asks for no password, sends name and email only, and says where the link went', async () => {
    // Fails if the form still asks for a password here, sends one, or tries to join at once.
    const calls = await signUp();
    const sent = calls.find((call) => call.url.endsWith('/api/auth/sign-up/email'));
    expect(sent?.body).toEqual({ name: 'Sam', email: 'sam@example.com' });
    expect(calls.some((call) => call.url.endsWith('/api/v1/invites/bind'))).toBe(false);
    expect(screen.getByText(/We sent a link to/u).textContent).toBe(
      'We sent a link to sam@example.com. Open it to finish joining Night shift.'
    );
    expect(screen.getByText(/The link works for 1 hour/u)).toBeTruthy();
    // The finishing link's page continues to this join page.
    expect(takeJoinPath()).toBe(window.location.pathname);
  });

  it('lets Resend go only after 30 seconds, says "Sent again" for 3, then waits again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = await signUp();
    const resend = () => screen.getByRole('button', { name: /Resend|Sending/u });
    expect(resend().textContent).toBe('Resend in 0:30');
    expect(resend()).toHaveProperty('disabled', true);
    for (let second = 0; second < 29; second++)
      await act(async () => vi.advanceTimersByTime(1_000));
    expect(resend()).toHaveProperty('disabled', true);
    for (let second = 0; second < 2; second++) await act(async () => vi.advanceTimersByTime(1_000));
    expect(resend().textContent).toBe('Resend');
    expect(resend()).toHaveProperty('disabled', false);
    await act(async () => {
      fireEvent.click(resend());
    });
    // A confirmation in a polite live region, not a disabled button.
    const sent = await screen.findByText('Sent again');
    expect(sent.closest('button')).toBeNull();
    expect(sent.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Resend/u })).toBeNull();
    expect(calls.find((call) => call.url.endsWith('/api/v1/account/password-reset'))?.body).toEqual(
      { email: 'sam@example.com' }
    );
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(resend().textContent).toBe('Resend in 0:30');
  });

  it('goes back to an empty form with "Use a different email"', async () => {
    await signUp();
    fireEvent.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(await screen.findByLabelText('Email')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Your name')).toHaveProperty('value', '');
  });

  it('keeps the password field where the space mails nothing', async () => {
    mockFetch({ [OPTIONS]: options(false) });
    render(<Admission {...props} />);
    expect(await screen.findByLabelText('Password')).toBeTruthy();
  });
});
