/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { SignedInDeviceList } from '@dorkos/shared/signed-in-devices';

import { TransportProvider } from '@/layers/shared/model';
import { SignedInDevicesSection } from '../ui/SignedInDevicesSection';
import { AuthClientProvider } from '../model/auth-client-context';
import { createFakeAuthClient } from './fake-auth-client';

const NOW = new Date().toISOString();

/** This computer signed in, plus a phone on Wi-Fi. */
function listWith(canSignOutOthers: boolean): SignedInDeviceList {
  return {
    canSignOutOthers,
    sessions: [
      {
        id: 'here',
        route: 'local',
        createdAt: NOW,
        lastSeenAt: NOW,
        current: true,
        name: 'Chrome on Mac',
      },
      {
        id: 'phone',
        route: 'wifi',
        createdAt: NOW,
        lastSeenAt: NOW,
        current: false,
        name: 'Safari on iPhone',
      },
    ],
  };
}

function setup(list: SignedInDeviceList) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport();
  vi.mocked(transport.listSignedInDevices).mockResolvedValue(list);
  const client = createFakeAuthClient();
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <AuthClientProvider client={client}>
          <SignedInDevicesSection />
        </AuthClientProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, client };
}

afterEach(() => cleanup());

describe('SignedInDevicesSection', () => {
  it('names each device by its browser, marking this one', async () => {
    setup(listWith(true));
    expect(await screen.findByText('Chrome on Mac')).toBeInTheDocument();
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument();
    expect(screen.queryByText(/This computer/)).not.toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText('Last active just now')).toBeInTheDocument();
    expect(screen.getByText('Wi-Fi · Last active just now')).toBeInTheDocument();
  });

  it('at this computer, signs out another device and everywhere else', async () => {
    const user = userEvent.setup();
    const { transport } = setup(listWith(true));
    await user.click(await screen.findByRole('button', { name: 'Sign out Safari on iPhone' }));
    await waitFor(() => expect(transport.signOutDevice).toHaveBeenCalledWith('phone'));

    await user.click(screen.getByRole('button', { name: 'Sign out everywhere else' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere else' }));
    await waitFor(() => expect(transport.signOutEverywhereElse).toHaveBeenCalledOnce());
  });

  it('reloads a stale list when a device had already gone, and says so', async () => {
    const user = userEvent.setup();
    const { transport } = setup(listWith(true));
    vi.mocked(transport.signOutDevice).mockRejectedValue(
      Object.assign(new Error('That sign-in has already ended.'), { status: 404 })
    );
    await screen.findByText('Safari on iPhone');
    expect(transport.listSignedInDevices).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iPhone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That list was out of date.');
    await waitFor(() => expect(transport.listSignedInDevices).toHaveBeenCalledTimes(2));
  });

  it('offers no Sign out on this device’s row, here or elsewhere', async () => {
    for (const canSignOutOthers of [true, false]) {
      setup(listWith(canSignOutOthers));
      const name = await screen.findByText('Chrome on Mac');
      const row = name.closest('div.rounded-md') as HTMLElement;
      expect(within(row).queryByRole('button')).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('elsewhere, offers no way to sign out other devices and says where', async () => {
    setup(listWith(false));
    await screen.findByText('Safari on iPhone');
    expect(screen.queryByRole('button', { name: /Sign out Safari/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Sign out everywhere else' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Sign out other devices on the computer DorkOS runs on.')
    ).toBeInTheDocument();
  });
});
