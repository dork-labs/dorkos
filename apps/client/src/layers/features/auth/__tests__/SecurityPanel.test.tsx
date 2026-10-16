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

/** Better Auth's answer to a sign-up with the owner's own email — the DOR-2964 dead end. */
const DUPLICATE_EMAIL = {
  data: null,
  error: {
    message: 'User already exists. Use another email.',
    status: 422,
    code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  },
};

/** Better Auth's answer to a wrong password. */
const WRONG_PASSWORD = {
  data: null,
  error: { message: 'Invalid email or password', status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' },
};

function configWith(authEnabled: boolean, ownerEmail: string | null): ServerConfig {
  return { auth: { enabled: authEnabled, ownerEmail } } as unknown as ServerConfig;
}

function setup(opts: { authEnabled: boolean; ownerEmail?: string | null; client?: AuthClient }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport();
  vi.mocked(transport.getConfig).mockResolvedValue(
    configWith(opts.authEnabled, opts.ownerEmail ?? null)
  );
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
    expect(
      await screen.findByRole('switch', { name: /ask for a password on this computer too/i })
    ).toBeInTheDocument();
    // …but nothing that implies a user concept.
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/API keys/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/signed in/i)).not.toBeInTheDocument();
  });

  it('offers no Standing permissions switch: Always allow on a request card replaced it', async () => {
    setup({ authEnabled: false });

    // The panel has drawn (its one switch is up), so the absence means something.
    await screen.findByRole('switch', { name: /ask for a password on this computer too/i });
    expect(screen.queryByRole('switch', { name: 'Standing permissions' })).not.toBeInTheDocument();
  });

  it('shows API keys when this computer asks for a password', async () => {
    setup({ authEnabled: true });
    expect(await screen.findByText('API keys')).toBeInTheDocument();
  });

  it('shows sign-out to anyone signed in, whether or not this computer asks', async () => {
    // Other devices always sign in, so a session exists with the switch off too.
    setup({
      authEnabled: false,
      client: createFakeAuthClient({
        getSession: vi.fn().mockResolvedValue({ data: SIGNED_IN_SESSION, error: null }),
      }),
    });
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('shows no sign-out with nobody signed in', async () => {
    setup({ authEnabled: true });
    await screen.findByText('API keys');
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('keeps API keys reachable after login is turned back off (DOR-1885)', async () => {
    // Turning "Ask for a password on this computer too" off does not delete the keys, expire the session,
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
    expect(screen.getByText(/keys still work with login off/i)).toBeInTheDocument();
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

    await user.click(
      await screen.findByRole('switch', { name: /ask for a password on this computer too/i })
    );

    // Owner-setup dialog appears; fill and submit.
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
    await user.type(screen.getByLabelText('Confirm password'), 'sup3rsecret');
    await user.click(screen.getByRole('button', { name: /create account & ask here too/i }));

    await waitFor(() => {
      expect(signUpEmail).toHaveBeenCalledWith(
        {
          email: 'owner@example.com',
          password: 'sup3rsecret',
          // Never the email: an empty name lets the app ask what to call them (DOR-2964).
          name: '',
        },
        // No setup code: this computer never needs one.
        undefined
      );
    });
    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({ auth: { enabled: true } });
    });
  });

  it('no owner yet: the create form starts with an empty email', async () => {
    const user = userEvent.setup();
    setup({ authEnabled: false, ownerEmail: null });

    await user.click(
      await screen.findByRole('switch', { name: /ask for a password on this computer too/i })
    );

    expect(screen.getByRole('dialog', { name: /create an owner account/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('');
  });

  describe('an owner already exists (DOR-2964)', () => {
    it('asks the owner to sign in instead of offering a create form', async () => {
      const user = userEvent.setup();
      setup({ authEnabled: false, ownerEmail: 'dorian@example.com' });

      await user.click(
        await screen.findByRole('switch', { name: /ask for a password on this computer too/i })
      );

      const dialog = screen.getByRole('dialog', { name: /ask for a password here too/i });
      expect(dialog).toHaveTextContent('Sign in as dorian@example.com');
      expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: /create an owner/i })).not.toBeInTheDocument();
    });

    it('a wrong password is refused and login stays off', async () => {
      const user = userEvent.setup();
      const signInEmail = vi.fn().mockResolvedValue(WRONG_PASSWORD);
      const { transport } = setup({
        authEnabled: false,
        ownerEmail: 'dorian@example.com',
        client: createFakeAuthClient({ signInEmail }),
      });

      await user.click(
        await screen.findByRole('switch', { name: /ask for a password on this computer too/i })
      );
      await user.type(screen.getByLabelText('Password'), 'not-it');
      await user.click(screen.getByRole('button', { name: /sign in & ask here too/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Wrong password. Login is still off.'
      );
      expect(signInEmail).toHaveBeenCalledWith({
        email: 'dorian@example.com',
        password: 'not-it',
      });
      expect(transport.updateConfig).not.toHaveBeenCalled();
    });

    it('the right password signs in first, then turns login on', async () => {
      const user = userEvent.setup();
      const order: string[] = [];
      const signInEmail = vi.fn().mockImplementation(async () => {
        order.push('sign-in');
        return { data: SIGNED_IN_SESSION, error: null };
      });
      const { transport } = setup({
        authEnabled: false,
        ownerEmail: 'dorian@example.com',
        client: createFakeAuthClient({ signInEmail }),
      });
      vi.mocked(transport.updateConfig).mockImplementation(async () => {
        order.push('enable');
      });

      await user.click(
        await screen.findByRole('switch', { name: /ask for a password on this computer too/i })
      );
      await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
      await user.click(screen.getByRole('button', { name: /sign in & ask here too/i }));

      await waitFor(() =>
        expect(transport.updateConfig).toHaveBeenCalledWith({ auth: { enabled: true } })
      );
      expect(order).toEqual(['sign-in', 'enable']);
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: /ask for a password here too/i })
        ).not.toBeInTheDocument()
      );
    });

    it('"Forgot it?" shows the reset command', async () => {
      const user = userEvent.setup();
      setup({ authEnabled: false, ownerEmail: 'dorian@example.com' });

      await user.click(
        await screen.findByRole('switch', { name: /ask for a password on this computer too/i })
      );
      expect(screen.queryByText('dorkos auth reset-password')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /forgot it\?/i }));

      expect(screen.getByText('dorkos auth reset-password')).toBeInTheDocument();
    });

    it.each([
      ['the owner’s own email', 'dorian@example.com', DUPLICATE_EMAIL],
      [
        'another email',
        'someone-else@example.com',
        {
          data: null,
          error: {
            message: 'Registration is closed.',
            status: 403,
            code: 'REGISTRATION_CLOSED',
          },
        },
      ],
    ])(
      'a sign-up with %s lands on the sign-in step, never turning login on unverified',
      async (_label, typedEmail, refusal) => {
        // The exact dead end: the panel's config read had not seen the owner,
        // so the create form opened, and sign-up refused.
        const user = userEvent.setup();
        const signUpEmail = vi.fn().mockResolvedValue(refusal);
        const { transport } = setup({
          authEnabled: false,
          ownerEmail: null,
          client: createFakeAuthClient({ signUpEmail }),
        });

        await user.click(
          await screen.findByRole('switch', { name: /ask for a password on this computer too/i })
        );
        vi.mocked(transport.getConfig).mockResolvedValue(configWith(false, 'dorian@example.com'));
        await user.type(screen.getByLabelText('Email'), typedEmail);
        await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
        await user.type(screen.getByLabelText('Confirm password'), 'sup3rsecret');
        await user.click(screen.getByRole('button', { name: /create account & ask here too/i }));

        // Always the owner's address from the fresh read, never just what was typed.
        const dialog = await screen.findByRole('dialog', { name: /ask for a password here too/i });
        expect(dialog).toHaveTextContent('Sign in as dorian@example.com');
        expect(screen.queryByText(/user already exists/i)).not.toBeInTheDocument();
        expect(transport.updateConfig).not.toHaveBeenCalled();
      }
    );
    it('a closed registration with no owner email found stays put and says why', async () => {
      const user = userEvent.setup();
      const signUpEmail = vi.fn().mockResolvedValue({
        data: null,
        error: {
          message: 'Registration is closed.',
          status: 403,
          code: 'REGISTRATION_CLOSED',
        },
      });
      const { transport } = setup({
        authEnabled: false,
        ownerEmail: null,
        client: createFakeAuthClient({ signUpEmail }),
      });

      await user.click(
        await screen.findByRole('switch', { name: /ask for a password on this computer too/i })
      );
      await user.type(screen.getByLabelText('Email'), 'someone-else@example.com');
      await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
      await user.type(screen.getByLabelText('Confirm password'), 'sup3rsecret');
      await user.click(screen.getByRole('button', { name: /create account & ask here too/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This computer already has an owner.'
      );
      expect(
        screen.queryByRole('dialog', { name: /ask for a password here too/i })
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/registration is closed/i)).not.toBeInTheDocument();
      expect(transport.updateConfig).not.toHaveBeenCalled();
    });
  });
});
