/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ServerConfig } from '@dorkos/shared/types';
// The panel now carries the standing-permissions block, which subscribes to the
// global event stream. This suite mounts the panel on its own rather than inside
// the shell, so there is no provider — stubbing the subscription keeps the suite
// about the panel instead of about the stream.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

import { TransportProvider } from '@/layers/shared/model';
import { SecurityPanel } from '../ui/SecurityPanel';
import { AuthClientProvider } from '../model/auth-client-context';
import { createFakeAuthClient } from './fake-auth-client';
import type { ApiKeyRecord, AuthClient, AuthSession } from '../model/auth-client';

/** A resolved owner session — what `getSession` returns once somebody is signed in. */
const SIGNED_IN_SESSION: AuthSession = {
  user: { id: 'owner-1', email: 'owner@example.com', name: 'Owner', role: 'owner' },
  session: { id: 's1', expiresAt: '2099-01-01T00:00:00Z', userId: 'owner-1' },
};

/** One existing key, as `/api/auth/api-key/list` returns it (never the secret). */
const KEY: ApiKeyRecord = {
  id: 'k1',
  name: 'laptop',
  start: 'dork_ab',
  prefix: 'dork',
  createdAt: '2026-07-01T00:00:00Z',
  expiresAt: null,
  enabled: true,
};

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

  it('offers standing permissions, disabled, while login is off', async () => {
    // Visible rather than hidden: the fix is the Require login toggle directly
    // above it, and somebody who read about the feature has to be able to find
    // out why it is unavailable.
    setup({ authEnabled: false });

    const toggle = await screen.findByRole('switch', { name: 'Standing permissions' });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(screen.getByText(/Turn on Require login above to use this/i)).toBeInTheDocument();
  });

  it('shows API keys and sign-out when auth is enabled', async () => {
    setup({ authEnabled: true });
    expect(await screen.findByText('API keys')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('keeps API keys reachable after login is turned back off (DOR-1885)', async () => {
    // Turning "Require login" off does not delete the keys, expire the session,
    // or stop the keys working — `/api/config` still reports `authSource:
    // 'user-keys'` and `/mcp` still accepts them. Hiding the section behind the
    // flag therefore left live credentials nobody could see or revoke, which is
    // how this was reported: "I made a key and the list never shows it."
    setup({
      authEnabled: false,
      client: createFakeAuthClient({
        getSession: vi.fn().mockResolvedValue({ data: SIGNED_IN_SESSION, error: null }),
        apiKeyList: vi.fn().mockResolvedValue({ data: { apiKeys: [KEY], total: 1 }, error: null }),
      }),
    });

    expect(await screen.findByText('API keys')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /revoke laptop/i })).toBeInTheDocument();
    // …and it says why they still matter with login off.
    expect(screen.getByText(/keep working while login is off/i)).toBeInTheDocument();
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
