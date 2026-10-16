/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { requestOwnerSetup, clearOwnerSetupRequest } from '@/layers/shared/lib';
import { OwnerSetupHost } from '../ui/OwnerSetupHost';
import { AuthClientProvider } from '../model/auth-client-context';
import { createFakeAuthClient } from './fake-auth-client';
import type { ServerConfig } from '@dorkos/shared/types';
import type { AuthClient } from '../model/auth-client';

function setup(client: AuthClient, ownerEmail: string | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport();
  vi.mocked(transport.getConfig).mockResolvedValue({
    auth: { enabled: false, ownerEmail },
  } as unknown as ServerConfig);
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <AuthClientProvider client={client}>
          <OwnerSetupHost />
        </AuthClientProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport };
}

describe('OwnerSetupHost — exposure flow', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    act(() => clearOwnerSetupRequest());
    cleanup();
  });

  it('renders nothing until an owner-setup request is raised', () => {
    setup(createFakeAuthClient());
    expect(screen.queryByText('Exposing DorkOS requires a login.')).not.toBeInTheDocument();
  });

  it('shows the exposure copy, then creates the owner, enables auth, and retries', async () => {
    const user = userEvent.setup();
    const signUpEmail = vi
      .fn()
      .mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
    const onComplete = vi.fn();
    const { transport } = setup(createFakeAuthClient({ signUpEmail }));

    act(() => {
      requestOwnerSetup({
        reason: 'exposure',
        message: 'Exposing DorkOS requires a login.',
        onComplete,
      });
    });

    expect(await screen.findByText('Exposing DorkOS requires a login.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
    await user.type(screen.getByLabelText('Confirm password'), 'sup3rsecret');
    await user.click(screen.getByRole('button', { name: /create account & continue/i }));

    await waitFor(() => expect(signUpEmail).toHaveBeenCalled());
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // Exposure needs only the owner: "Ask for a password on this computer too"
    // stays as the person set it.
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  describe('an owner already exists (DOR-2964)', () => {
    function raise(onComplete: () => void) {
      act(() => {
        requestOwnerSetup({
          reason: 'exposure',
          message: 'Exposing DorkOS requires a login.',
          onComplete,
        });
      });
    }

    it('asks the owner to sign in, and continues only after it succeeds', async () => {
      const user = userEvent.setup();
      const signInEmail = vi.fn().mockResolvedValue({ data: null, error: null });
      const onComplete = vi.fn();
      const { transport } = setup(createFakeAuthClient({ signInEmail }), 'dorian@example.com');

      raise(onComplete);

      const dialog = await screen.findByRole('dialog', { name: /^sign in$/i });
      expect(dialog).toHaveTextContent('Sign in as dorian@example.com');
      await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
      await user.click(screen.getByRole('button', { name: /sign in & continue/i }));

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(transport.updateConfig).not.toHaveBeenCalled();
      expect(signInEmail).toHaveBeenCalledWith({
        email: 'dorian@example.com',
        password: 'sup3rsecret',
      });
      await waitFor(() => expect(onComplete).toHaveBeenCalled());
    });

    it('a sign-up that hits the existing owner moves to sign-in and enables nothing', async () => {
      const user = userEvent.setup();
      const signUpEmail = vi.fn().mockResolvedValue({
        data: null,
        error: {
          message: 'User already exists. Use another email.',
          status: 422,
          code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
        },
      });
      const onComplete = vi.fn();
      const { transport } = setup(createFakeAuthClient({ signUpEmail }));

      raise(onComplete);

      await screen.findByRole('dialog', { name: /create an owner account/i });
      await user.type(screen.getByLabelText('Email'), 'dorian@example.com');
      await user.type(screen.getByLabelText('Password'), 'sup3rsecret');
      await user.type(screen.getByLabelText('Confirm password'), 'sup3rsecret');
      await user.click(screen.getByRole('button', { name: /create account & continue/i }));

      const dialog = await screen.findByRole('dialog', { name: /^sign in$/i });
      expect(dialog).toHaveTextContent('Sign in as dorian@example.com');
      expect(transport.updateConfig).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
    });
  });
});
