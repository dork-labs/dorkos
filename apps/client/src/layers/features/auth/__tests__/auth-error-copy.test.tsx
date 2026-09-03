/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeAuthError } from '../lib/auth-error-copy';
import { OwnerSetupScreen } from '../ui/OwnerSetupScreen';
import { AuthClientProvider } from '../model/auth-client-context';
import { createFakeAuthClient } from './fake-auth-client';
import type { AuthClient, AuthError } from '../model/auth-client';

/** Better Auth's refusal for an `Origin` that is not on its trusted list. */
const invalidOrigin: AuthError = { message: 'Invalid origin', status: 403, code: 'INVALID_ORIGIN' };

describe('describeAuthError', () => {
  it('says nothing when nothing failed', () => {
    expect(describeAuthError(null)).toBeNull();
    expect(describeAuthError(undefined)).toBeNull();
  });

  /**
   * DOR-1744. `Invalid origin` is two words of the auth library's vocabulary. On
   * the owner-setup dialog it was the whole explanation for why the desktop app
   * in development could not create an account, which is a dead end rather than
   * an error.
   */
  it('explains a refused origin, and names the address to allow', () => {
    const copy = describeAuthError(invalidOrigin, 'http://localhost:5174');
    expect(copy?.message).toContain('disagree about where this request came from');
    expect(copy?.message).toContain('http://localhost:5174');
    expect(copy?.message).toContain('DORKOS_CORS_ORIGIN');
    // The raw string survives — the sentence is for the person, the detail is
    // what they paste into a search or a bug report.
    expect(copy?.detail).toBe('Invalid origin');
  });

  it('matches the refusal by code even if the wording changes', () => {
    const renamed: AuthError = {
      message: 'Origin not allowed',
      status: 403,
      code: 'INVALID_ORIGIN',
    };
    expect(describeAuthError(renamed)?.message).toContain('disagree about where this request');
    expect(describeAuthError(renamed)?.detail).toBe('Origin not allowed');
  });

  it('still explains itself when the caller does not know the address', () => {
    const copy = describeAuthError(invalidOrigin);
    expect(copy?.message).toContain("this app's address");
    expect(copy?.message).not.toContain('undefined');
  });

  it('explains a missing origin, which is a different fix', () => {
    const copy = describeAuthError({
      message: 'Missing or null Origin',
      status: 403,
      code: 'MISSING_OR_NULL_ORIGIN',
    });
    expect(copy?.message).toContain('did not tell the server where this request came from');
    expect(copy?.detail).toBe('Missing or null Origin');
  });

  it('keeps the rate-limit copy the login screen used to own', () => {
    expect(
      describeAuthError({ message: 'Too many requests', status: 429, retryAfter: 30 })
    ).toEqual({ message: 'Too many attempts. Try again in 30s.', detail: null });
    expect(describeAuthError({ message: 'Too many requests', status: 429 })?.message).toBe(
      'Too many attempts. Try again in a little while.'
    );
  });

  it('passes through a message the server already wrote for people', () => {
    // Flattening these into something vaguer would be a loss, not a gain.
    const closed: AuthError = {
      message: 'Registration is closed. An owner account already exists for this DorkOS instance.',
      status: 403,
      code: 'REGISTRATION_CLOSED',
    };
    expect(describeAuthError(closed)).toEqual({ message: closed.message, detail: null });
  });
});

describe('OwnerSetupScreen — a refused origin', () => {
  afterEach(cleanup);

  function setup(client: AuthClient) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthClientProvider client={client}>
          <OwnerSetupScreen onCreated={vi.fn()} />
        </AuthClientProvider>
      </QueryClientProvider>
    );
  }

  it('shows the plain sentence, with the raw wording beneath it', async () => {
    const user = userEvent.setup();
    setup(
      createFakeAuthClient({
        signUpEmail: vi.fn().mockResolvedValue({ data: null, error: invalidOrigin }),
      })
    );

    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
    await user.type(screen.getByLabelText('Confirm password'), 'sup3rsecret');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    const alert = await screen.findByRole('alert');
    await waitFor(() =>
      expect(alert).toHaveTextContent(/disagree about where this request came from/)
    );
    // Named, so the person knows which address to allow.
    expect(alert).toHaveTextContent(window.location.origin);
    // And the auth layer's own words are still on screen.
    expect(alert).toHaveTextContent('Invalid origin');
  });
});
