/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ServerConfig } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { SecurityPanel } from '../ui/SecurityPanel';
import { AuthClientProvider } from '../model/auth-client-context';
import { createFakeAuthClient } from './fake-auth-client';
import type { AuthClient } from '../model/auth-client';

function setup(opts: { authEnabled: boolean; client?: AuthClient }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport();
  vi.mocked(transport.getConfig).mockResolvedValue({
    auth: { enabled: opts.authEnabled },
  } as unknown as ServerConfig);
  const client = opts.client ?? createFakeAuthClient();

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <AuthClientProvider client={client}>
          <SecurityPanel />
        </AuthClientProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, client };
}

describe('SecurityPanel', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('renders no user affordances when auth is disabled', async () => {
    setup({ authEnabled: false });
    // The single entry point is present…
    expect(await screen.findByRole('switch', { name: /require login/i })).toBeInTheDocument();
    // …but nothing that implies a user concept.
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/API keys/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/signed in/i)).not.toBeInTheDocument();
  });

  it('shows API keys and sign-out when auth is enabled', async () => {
    setup({ authEnabled: true });
    expect(await screen.findByText('API keys')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('owner setup: signs up, then enables auth.enabled', async () => {
    const user = userEvent.setup();
    const signUpEmail = vi
      .fn()
      .mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
    const { transport } = setup({
      authEnabled: false,
      client: createFakeAuthClient({ signUpEmail }),
    });

    await user.click(await screen.findByRole('switch', { name: /require login/i }));

    // Owner-setup dialog appears; fill and submit.
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
    await user.type(screen.getByLabelText('Confirm password'), 'sup3rsecret');
    await user.click(screen.getByRole('button', { name: /create account & require login/i }));

    await waitFor(() => {
      expect(signUpEmail).toHaveBeenCalledWith({
        email: 'owner@example.com',
        password: 'sup3rsecret',
        name: 'owner@example.com',
      });
    });
    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({ auth: { enabled: true } });
    });
  });
});
