// @vitest-environment jsdom
/**
 * Wi-Fi access in Settings (DOR-2930): the switch, the addresses and QR code
 * once it is open, the owner-setup walk when login is off, and the note when
 * `DORKOS_HOST` decides instead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createLanAccessStatus, createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { clearOwnerSetupRequest, getOwnerSetupRequest } from '@/layers/shared/lib';
import { LanAccessSection } from '../ui/lan-access/LanAccessSection';

vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}));

afterEach(() => {
  cleanup();
  clearOwnerSetupRequest();
});

function renderWith(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <LanAccessSection />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('LanAccessSection', () => {
  it('shows the switch off, says the connection is not encrypted, and shows no address', async () => {
    renderWith(createMockTransport());
    const toggle = await screen.findByRole('switch', { name: 'Let devices on my Wi-Fi in' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/isn’t encrypted yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
  });

  it('turns on, then shows the .local address as a QR code and the IP as a backup', async () => {
    const open = createLanAccessStatus({ enabled: true, listening: true });
    const transport = createMockTransport({ setLanAccess: vi.fn().mockResolvedValue(open) });
    renderWith(transport);

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Let devices on my Wi-Fi in' })
    );

    expect(transport.setLanAccess).toHaveBeenCalledWith(true);
    expect(await screen.findByTestId('qr-code')).toHaveTextContent('http://studio.local:4242');
    expect(screen.getByText('http://192.168.1.20:4242')).toBeInTheDocument();
  });

  it('walks into owner setup when login is off, and switches on once it is done', async () => {
    const refusal = Object.assign(new Error('Exposing DorkOS requires a login.'), {
      code: 'AUTH_REQUIRED_FOR_EXPOSURE',
    });
    const setLanAccess = vi
      .fn()
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce(createLanAccessStatus({ enabled: true, listening: true }));
    renderWith(createMockTransport({ setLanAccess }));

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Let devices on my Wi-Fi in' })
    );

    await waitFor(() => expect(getOwnerSetupRequest()).not.toBeNull());
    expect(getOwnerSetupRequest()?.message).toBe('Wi-Fi access needs a login.');
    getOwnerSetupRequest()?.onComplete();
    await waitFor(() => expect(setLanAccess).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('qr-code')).toBeInTheDocument();
  });

  it('greys out the switch and says why on a computer it does not work on yet', async () => {
    const transport = createMockTransport({
      getLanAccess: vi.fn().mockResolvedValue(
        createLanAccessStatus({
          supported: false,
          error: 'Wi-Fi access works on a Mac for now. Elsewhere, set DORKOS_HOST.',
        })
      ),
    });
    renderWith(transport);
    const toggle = await screen.findByRole('switch', { name: 'Let devices on my Wi-Fi in' });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/works on a Mac for now/)).toBeInTheDocument();
  });

  it('disables the switch and says why while DORKOS_HOST is set', async () => {
    const transport = createMockTransport({
      getLanAccess: vi
        .fn()
        .mockResolvedValue(
          createLanAccessStatus({ enabled: true, setByEnvironment: 'DORKOS_HOST=0.0.0.0' })
        ),
    });
    renderWith(transport);
    const toggle = await screen.findByRole('switch', { name: 'Let devices on my Wi-Fi in' });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText('DORKOS_HOST=0.0.0.0 is set, so it decides where DorkOS listens.')
    ).toBeInTheDocument();
  });
});
