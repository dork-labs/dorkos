/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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
import { PermissionPrimer } from '../ui/PermissionPrimer';
import {
  armPermissionPrimer,
  resetPermissionPrimerForTests,
  LONG_TURN_MS,
} from '../model/primer-trigger';

const CARD = 'Want a nudge when this needs you?';

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn().mockResolvedValue('granted');
}

function renderPrimer(
  { streaming = false, prefs = {} }: { streaming?: boolean; prefs?: Partial<NotificationPrefs> },
  overrides: Partial<Transport> = {}
) {
  const config = {
    notifications: { ...NOTIFICATION_PREFS_DEFAULTS, ...prefs },
  } as unknown as ServerConfig;
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  const view = render(<PermissionPrimer streaming={streaming} />, { wrapper });
  return { transport, view };
}

beforeEach(() => {
  resetPermissionPrimerForTests();
  resetLegacySoundImportForTests();
  localStorage.clear();
  delete window.electronAPI;
  vi.stubGlobal('Notification', FakeNotification);
  FakeNotification.permission = 'default';
  FakeNotification.requestPermission = vi.fn().mockResolvedValue('granted');
  refreshNotificationPermissionForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PermissionPrimer', () => {
  it('says nothing at launch', () => {
    // The whole reason it exists. A prompt on arrival is the pattern everybody
    // dismisses reflexively, and in Chrome a reflexive block is permanent.
    renderPrimer({});
    expect(screen.queryByText(CARD, { exact: false })).not.toBeInTheDocument();
  });

  it('says nothing while a turn is merely running', () => {
    vi.useFakeTimers();
    renderPrimer({ streaming: true });
    act(() => {
      vi.advanceTimersByTime(LONG_TURN_MS - 1);
    });
    expect(screen.queryByText(CARD, { exact: false })).not.toBeInTheDocument();
  });

  it('appears once a turn has run long enough to walk away from', () => {
    vi.useFakeTimers();
    renderPrimer({ streaming: true });
    act(() => {
      vi.advanceTimersByTime(LONG_TURN_MS);
    });
    expect(screen.getByText(CARD, { exact: false })).toBeInTheDocument();
  });

  it('appears when something has genuinely stopped and is waiting', () => {
    renderPrimer({});
    act(() => armPermissionPrimer());
    expect(screen.getByText(CARD, { exact: false })).toBeInTheDocument();
  });

  it('stays away once the person has already answered it', () => {
    renderPrimer({ prefs: { browserPermissionPrimerDismissed: true } });
    act(() => armPermissionPrimer());
    expect(screen.queryByText(CARD, { exact: false })).not.toBeInTheDocument();
  });

  it('stays away when the browser has already been asked', () => {
    // Granted needs no asking; denied cannot be re-asked by us at all, so a
    // button offering to would do nothing.
    for (const permission of ['granted', 'denied'] as const) {
      FakeNotification.permission = permission;
      refreshNotificationPermissionForTests();
      const { view } = renderPrimer({});
      act(() => armPermissionPrimer());
      expect(screen.queryByText(CARD, { exact: false })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('stays away in the desktop app, which has its own notifications', () => {
    window.electronAPI = { getServerPort: () => 4242 } as unknown as ElectronAPI;
    renderPrimer({});
    act(() => armPermissionPrimer());
    expect(screen.queryByText(CARD, { exact: false })).not.toBeInTheDocument();
  });

  it('"Not now" is a real answer: it goes away and is recorded on the server', async () => {
    const user = userEvent.setup();
    const { transport } = renderPrimer({});
    act(() => armPermissionPrimer());

    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(screen.queryByText(CARD, { exact: false })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        notifications: { browserPermissionPrimerDismissed: true },
      })
    );
  });

  it('"Turn on notifications" asks the browser and records that it was asked', async () => {
    const user = userEvent.setup();
    const { transport } = renderPrimer({});
    act(() => armPermissionPrimer());

    await user.click(screen.getByRole('button', { name: 'Turn on notifications' }));

    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        notifications: { browserPermissionPrimerDismissed: true },
      })
    );
  });

  it('goes away even when the write cannot persist', async () => {
    // `updateConfig` is a no-op on the Obsidian transport, and any transport can
    // answer 200 without the value coming back. A card that reappeared the
    // moment it was answered reads as a broken button.
    const user = userEvent.setup();
    renderPrimer({}, { updateConfig: vi.fn().mockRejectedValue(new Error('nope')) });
    act(() => armPermissionPrimer());

    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(screen.queryByText(CARD, { exact: false })).not.toBeInTheDocument();
  });
});
