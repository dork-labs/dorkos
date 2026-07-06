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
import type { AuthClient } from '../model/auth-client';

function setup(client: AuthClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport();
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
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ auth: { enabled: true } })
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});
