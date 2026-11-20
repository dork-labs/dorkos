/**
 * @vitest-environment jsdom
 *
 * Settings › Signing in from other devices (DOR-3647): the owner's passkeys
 * and authenticator apps.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';

import { TransportProvider } from '@/layers/shared/model';
import { OwnerFactorsSection } from '../ui/OwnerFactorsSection';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport();
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <OwnerFactorsSection />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

afterEach(() => cleanup());

describe('OwnerFactorsSection', () => {
  it('says when it is asked, and how to get back in', async () => {
    setup();
    expect(
      await screen.findByText('Asked when you sign in from another device. Never at this computer.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Lost it? Sign in on the computer DorkOS runs on and remove it.')
    ).toBeInTheDocument();
  });

  it('adds an authenticator app once one of its codes is confirmed', async () => {
    const transport = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Authenticator app' }));
    expect(await screen.findByText('Scan this with your authenticator app.')).toBeInTheDocument();
    expect(screen.getByText('ABCD EFGH')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type the 6-digit code it shows.'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(transport.confirmAuthenticator).toHaveBeenCalledWith('f2', '123456')
    );
    await waitFor(() =>
      expect(screen.queryByText('Scan this with your authenticator app.')).not.toBeInTheDocument()
    );
  });

  it('lists each one with a way to remove it', async () => {
    const transport = setup();
    vi.mocked(transport.listOwnerFactors).mockResolvedValue({
      factors: [
        {
          id: 'k1',
          kind: 'passkey',
          label: 'Laptop',
          host: 'studio.example',
          addedAt: '2026-11-20T00:00:00Z',
        },
      ],
    });
    cleanup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <OwnerFactorsSection />
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText(/^Passkey · studio\.example · added/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Passkey' }));
    expect(await screen.findByText('Remove this passkey?')).toBeInTheDocument();
    expect(
      screen.getByText('Other devices will sign in with your password only.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(transport.removeOwnerFactor).toHaveBeenCalledWith('k1'));
  });

  it('shows nothing to a caller the server will not show them to', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const transport = createMockTransport();
    vi.mocked(transport.listOwnerFactors).mockRejectedValue(
      Object.assign(new Error('no'), { status: 403 })
    );
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <OwnerFactorsSection />
        </TransportProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
