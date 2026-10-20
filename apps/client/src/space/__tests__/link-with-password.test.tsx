// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkWithPassword } from '../sign-up/LinkWithPassword.js';
import { linkedMessage } from '../sign-up/SignInLinkedNotice.js';
import { describeSignInError, returnedSignIn } from '../sign-in-options.js';
import { mockFetch, refusal, type Reply } from '../owner-replacement/__tests__/harness.js';

const NOTICE = 'GET /api/v1/sign-in-link/notice';
const LINK = 'POST /api/v1/sign-in-link';
const CANCEL = 'DELETE /api/v1/sign-in-link';
const pending: Reply = { status: 200, body: { state: 'pending', provider: 'Google' } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
  window.history.replaceState(null, '', '/');
});

/** Fill the password and press the button. */
async function submit(password = 'old-password-1234') {
  fireEvent.change(await screen.findByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Link and sign in' }));
}

describe('the link-with-password panel', () => {
  it('asks for the matched account’s password, names the sign-in, and links', async () => {
    // Purpose: fails if a held sign-in still dead-ends with an error, or the panel does not say
    // which sign-in it links, or a right password does not finish signed in.
    const calls = mockFetch({ [NOTICE]: pending, [LINK]: { status: 200, body: { linked: true } } });
    const onLinked = vi.fn();
    render(<LinkWithPassword onCancel={() => {}} onLinked={onLinked} />);
    expect(await screen.findByText('This email already has an account here.')).toBeTruthy();
    expect(screen.getByText('Enter its password to link Google sign-in.')).toBeTruthy();
    await submit();
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      password: 'old-password-1234',
    });
  });

  it('lets a wrong password be tried again', async () => {
    // Purpose: fails if a wrong password ends the sign-in or says something vaguer.
    mockFetch({
      [NOTICE]: pending,
      [LINK]: refusal(403, 'REAUTH_FAILED', 'That password is not right.'),
    });
    render(<LinkWithPassword onCancel={() => {}} onLinked={() => {}} />);
    await submit('wrong');
    expect(await screen.findByText('That password is not right.')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('ends with the right words for an expired sign-in, an account with no password, and too many tries', async () => {
    // Purpose: fails if a dead end keeps offering a password field, or tells a password-less
    // account its password is wrong.
    for (const [reply, words] of [
      [
        refusal(410, 'LINK_EXPIRED', 'This sign-in link expired.'),
        'This took too long. Sign in again.',
      ],
      [
        refusal(403, 'PASSWORD_REQUIRED', 'No password.'),
        "This account has no password. Ask the space's owner for help.",
      ],
      [
        refusal(
          429,
          'RATE_LIMITED',
          'Too many wrong passwords. Wait a minute, then sign in again.'
        ),
        'Too many wrong passwords. Wait a minute, then sign in again.',
      ],
    ] as const) {
      mockFetch({ [NOTICE]: pending, [LINK]: reply });
      render(<LinkWithPassword onCancel={() => {}} onLinked={() => {}} />);
      await submit();
      expect(await screen.findByText(words)).toBeTruthy();
      expect(screen.queryByLabelText('Password')).toBeNull();
      cleanup();
    }
  });

  it('says the sign-in expired when nothing is waiting any more', async () => {
    // Purpose: fails if a stale `?error=link_needs_password` shows a form that can never work.
    mockFetch({ [NOTICE]: { status: 200, body: { state: 'none', provider: null } } });
    render(<LinkWithPassword onCancel={() => {}} onLinked={() => {}} />);
    expect(await screen.findByText('This took too long. Sign in again.')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('cancels the waiting sign-in on the server', async () => {
    // Purpose: fails if "Cancel" only hides the panel and leaves the sign-in usable.
    const calls = mockFetch({ [NOTICE]: pending, [CANCEL]: { status: 204 } });
    const onCancel = vi.fn();
    render(<LinkWithPassword onCancel={onCancel} onLinked={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });
});

describe('what a returning sign-in says', () => {
  it('turns a held sign-in into the panel, and every other return into its message', () => {
    // Purpose: fails if `link_needs_password` shows as an error, or the unverified-email
    // message still points at the old "link from Settings" dead end.
    expect(returnedSignIn({ code: 'link_needs_password', message: 'x' })).toEqual({
      error: '',
      linking: true,
    });
    expect(returnedSignIn(null)).toEqual({ error: '', linking: false });
    expect(describeSignInError('account_not_linked')).toBe(
      "That sign-in didn't confirm your email, so it wasn't linked. Sign in with your password."
    );
  });

  it('shows the server’s refusal reason only when it is one the server gives', async () => {
    // Purpose: fails if anyone can put words on the sign-in page through the address, or if a
    // closed or erased account is told only that sign-in failed.
    window.history.replaceState(
      null,
      '',
      '/?error=sign_in_refused&error_description=This%20account%20has%20been%20closed.'
    );
    const fresh = await import('../sign-in-options.js');
    expect(fresh.takeSignInFailure()).toEqual({
      code: 'sign_in_refused',
      message: 'This account has been closed.',
    });
    expect(window.location.search).toBe('');
    vi.resetModules();
    window.history.replaceState(
      null,
      '',
      '/?error=sign_in_refused&error_description=Call%20this%20number%20now'
    );
    const forged = await import('../sign-in-options.js');
    expect(forged.takeSignInFailure()?.message).toBe("This account can't sign in right now.");
  });

  it('says a trusted link happened, and whether the old sign-ins went', () => {
    // Purpose: fails if a takeover of a never-confirmed account is not said out loud.
    expect(linkedMessage({ state: 'linked', provider: 'DorkOS' })).toBe(
      'DorkOS sign-in is now linked to this account.'
    );
    expect(linkedMessage({ state: 'linkedCleared', provider: 'DorkOS' })).toBe(
      'DorkOS sign-in is linked. The old password and other sign-ins were removed.'
    );
    expect(linkedMessage({ state: 'pending', provider: 'Google' })).toBeNull();
    expect(linkedMessage({ state: 'none', provider: null })).toBeNull();
  });
});
