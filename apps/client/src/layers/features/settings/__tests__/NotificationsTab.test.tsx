/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { NotificationPrefs } from '@dorkos/shared/config-schema';
import { NOTIFICATION_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, refreshNotificationPermissionForTests } from '@/layers/shared/model';
import { configKeys, resetLegacySoundImportForTests } from '@/layers/entities/config';
import { NotificationsTab } from '../ui/tabs/NotificationsTab';

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn().mockResolvedValue('granted');
}

function renderTab(prefs: Partial<NotificationPrefs> = {}): { transport: Transport } {
  const config = {
    notifications: { ...NOTIFICATION_PREFS_DEFAULTS, ...prefs },
  } as unknown as ServerConfig;
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<NotificationsTab />, { wrapper });
  return { transport };
}

beforeEach(() => {
  resetLegacySoundImportForTests();
  localStorage.clear();
  delete window.electronAPI;
  vi.stubGlobal('Notification', FakeNotification);
  FakeNotification.permission = 'default';
  FakeNotification.requestPermission = vi.fn().mockResolvedValue('granted');
  refreshNotificationPermissionForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotificationsTab', () => {
  it('shows every sound switch in the position config says', () => {
    renderTab({ sounds: { knock: true, allClear: false, turnEnd: false } });

    expect(screen.getByRole('switch', { name: /Knock when an agent needs you/ })).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /Chime when everything is answered/ })
    ).not.toBeChecked();
    expect(
      screen.getByRole('switch', { name: /Chime every time a turn finishes/ })
    ).not.toBeChecked();
  });

  it('writes only the switch that was flipped', async () => {
    const user = userEvent.setup();
    const { transport } = renderTab();

    await user.click(screen.getByRole('switch', { name: /Chime every time a turn finishes/ }));

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        notifications: { sounds: { turnEnd: true } },
      })
    );
  });

  it('writes the while-away setting', async () => {
    const user = userEvent.setup();
    const { transport } = renderTab();

    await user.click(
      screen.getByRole('switch', { name: /Tell me when something finishes while I am away/ })
    );

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        notifications: { notifyOnTurnCompleteWhileAway: false },
      })
    );
  });

  it('writes the escalation delay, keeping `never` a word and the rest numbers', async () => {
    const user = userEvent.setup();
    const { transport } = renderTab();

    await user.click(screen.getByRole('radio', { name: 'Never' }));
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        notifications: { escalation: { phoneAfterMinutes: 'never' } },
      })
    );

    await user.click(screen.getByRole('radio', { name: '15 min' }));
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenLastCalledWith({
        notifications: { escalation: { phoneAfterMinutes: 15 } },
      })
    );
  });

  it('offers to turn browser notifications on when they have never been asked for', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
  });

  it('says what a blocked browser means and offers no dead button', () => {
    // DorkOS cannot re-ask a browser that has been told no, so a button here
    // would do nothing at all.
    FakeNotification.permission = 'denied';
    refreshNotificationPermissionForTests();
    renderTab();

    expect(screen.getByText(/Blocked\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument();
  });

  it('tells the desktop app that this setting is not its business', () => {
    window.electronAPI = { getServerPort: () => 4242 } as unknown as ElectronAPI;
    renderTab();

    expect(screen.getByText(/The desktop app shows its own notifications/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument();
  });

  it('says so when the delay is set but nothing could carry it', async () => {
    // A knob with no device and no chat app behind it is a timer that can never
    // fire, and saying nothing about that is how somebody trusts one.
    renderTab();
    expect(
      await screen.findByText(/Nothing can carry that yet\./, {}, { timeout: 2000 })
    ).toBeInTheDocument();
  });

  it('drops the warning once the delay is off, because nothing is meant to fire', async () => {
    renderTab({ escalation: { phoneAfterMinutes: 'never' } });

    // The devices row is what proves the section rendered at all, so the absence
    // below is an absence and not an empty screen.
    expect(await screen.findByText(/Devices DorkOS can reach/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing can carry that yet\./)).not.toBeInTheDocument();
  });
});
