/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DorkOSSignInScreen } from '../ui/DorkOSSignInScreen';
import { AuthClientProvider } from '../model/auth-client-context';
import { createFakeAuthClient } from './fake-auth-client';
import type { AuthClient } from '../model/auth-client';

const assign = vi.fn();

function renderScreen(client: AuthClient) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthClientProvider client={client}>
        <DorkOSSignInScreen />
      </AuthClientProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  assign.mockReset();
  vi.stubGlobal('location', {
    ...window.location,
    href: 'http://localhost:3000/session?session=abc',
    origin: 'http://localhost:3000',
    search: '?session=abc',
    assign,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('DorkOSSignInScreen', () => {
  it('sends the browser to DorkOS, asking to come back to this page', async () => {
    const social = vi.fn().mockResolvedValue({
      data: { url: 'https://id.example/authorize?x=1', redirect: true },
      error: null,
    });
    renderScreen(createFakeAuthClient({ signInSocial: social }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://id.example/authorize?x=1'));
    expect(social).toHaveBeenCalledWith({
      provider: 'dorkos',
      callbackURL: '/session?session=abc',
      errorCallbackURL: '/session?session=abc&dorkos-sign-in=failed',
    });
  });

  it('says so when DorkOS sign-in is unavailable, and stays put', async () => {
    const social = vi.fn().mockResolvedValue({
      data: null,
      error: {
        message: 'Sign-in with DorkOS is unavailable right now. Try again soon.',
        status: 503,
        code: 'hub_sign_in_unavailable',
      },
    });
    renderScreen(createFakeAuthClient({ signInSocial: social }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
    await waitFor(() => expect(screen.getByText(/unavailable|try again/i)).toBeInTheDocument());
    expect(assign).not.toHaveBeenCalled();
  });

  it('asks to try again when the sign-in did not finish for another reason', () => {
    vi.stubGlobal('location', {
      ...window.location,
      href: 'http://localhost:3000/?dorkos-sign-in=failed&error=access_denied',
      origin: 'http://localhost:3000',
      search: '?dorkos-sign-in=failed&error=access_denied',
      assign,
    });
    renderScreen(createFakeAuthClient());
    expect(screen.getByText('Sign-in didn’t finish. Try again.')).toBeInTheDocument();
  });

  it('says when DorkOS turned the account away', () => {
    vi.stubGlobal('location', {
      ...window.location,
      href: 'http://localhost:3000/?dorkos-sign-in=failed&error=unable_to_get_user_info',
      origin: 'http://localhost:3000',
      search: '?dorkos-sign-in=failed&error=unable_to_get_user_info',
      assign,
    });
    renderScreen(createFakeAuthClient());
    expect(screen.getByText('That DorkOS account can’t sign in here.')).toBeInTheDocument();
  });
});
