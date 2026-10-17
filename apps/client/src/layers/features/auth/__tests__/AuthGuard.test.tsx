/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setAuthRequired, setSignInWith } from '@/layers/shared/lib';
import { AuthGuard } from '../ui/AuthGuard';
import { AuthClientProvider } from '../model/auth-client-context';
import type { AuthClient } from '../model/auth-client';

function fakeAuthClient(): AuthClient {
  return {
    signIn: {
      email: vi.fn().mockResolvedValue({ data: { token: 't' }, error: null }),
      social: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    signUp: { email: vi.fn().mockResolvedValue({ data: null, error: null }) },
    signOut: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    getSession: vi.fn().mockResolvedValue({ data: null, error: null }),
    apiKey: {
      create: vi.fn().mockResolvedValue({ data: null, error: null }),
      list: vi.fn().mockResolvedValue({ data: { apiKeys: [], total: 0 }, error: null }),
      delete: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    },
  };
}

function renderGuard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthClientProvider client={fakeAuthClient()}>
        <AuthGuard>
          <div>protected app</div>
        </AuthGuard>
      </AuthClientProvider>
    </QueryClientProvider>
  );
}

describe('AuthGuard', () => {
  afterEach(() => {
    act(() => {
      setSignInWith('password');
      setAuthRequired(false);
    });
    cleanup();
  });

  it('offers only a DorkOS sign-in when the server says to sign in with DorkOS', () => {
    renderGuard();
    act(() => {
      setSignInWith('dorkos');
      setAuthRequired(true);
    });
    expect(screen.getByRole('button', { name: 'Continue with DorkOS' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('renders children when auth is not required', () => {
    renderGuard();
    expect(screen.getByText('protected app')).toBeInTheDocument();
    expect(screen.queryByText('Sign in to DorkOS')).not.toBeInTheDocument();
  });

  it('renders the login screen when the auth-required state is set', () => {
    renderGuard();
    act(() => setAuthRequired(true));
    expect(screen.getByText('Sign in to DorkOS')).toBeInTheDocument();
    expect(screen.queryByText('protected app')).not.toBeInTheDocument();
  });

  it('returns to children when the auth-required state is cleared', () => {
    renderGuard();
    act(() => setAuthRequired(true));
    expect(screen.getByText('Sign in to DorkOS')).toBeInTheDocument();
    act(() => setAuthRequired(false));
    expect(screen.getByText('protected app')).toBeInTheDocument();
  });
});
