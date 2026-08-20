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
import { NOTIFICATION_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { ReachMeSection } from '../ui/ReachMeSection';

const ENDPOINT = 'https://fcm.googleapis.com/very-secret';

/** A `PushSubscription.toJSON()` shape, as a browser produces it. */
function browserSubscription(endpoint = ENDPOINT) {
  return {
    toJSON: () => ({ endpoint, keys: { p256dh: 'pub-key', auth: 'auth-key' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

/** Install a working `navigator.serviceWorker` + `PushManager`. */
function stubPushCapableBrowser(
  options: { existing?: ReturnType<typeof browserSubscription> } = {}
) {
  const subscribe = vi.fn().mockResolvedValue(browserSubscription());
  const registration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(options.existing ?? null),
      subscribe,
    },
  };
  const register = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal('navigator', {
    ...navigator,
    serviceWorker: {
      register,
      ready: Promise.resolve(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
    },
  });
  vi.stubGlobal('PushManager', class {});
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  return { register, subscribe };
}

/**
 * A browser with no service worker and no `PushManager` — jsdom's own default,
 * stated explicitly so the case does not depend on jsdom never growing them.
 */
function stubPushIncapableBrowser() {
  vi.stubGlobal('navigator', { userAgent: 'test' });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deleting an optional global is exactly the condition under test
  delete (window as any).PushManager;
}

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn().mockResolvedValue('granted');
}

function renderSection(transportOverrides: Partial<Transport> = {}): { transport: Transport } {
  const config = { notifications: NOTIFICATION_PREFS_DEFAULTS } as unknown as ServerConfig;
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    getPushVapidPublicKey: vi.fn().mockResolvedValue({ key: 'BJxAbCd_-vapid' }),
    listPushSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
    getBindings: vi.fn().mockResolvedValue([]),
    ...transportOverrides,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<ReachMeSection />, { wrapper });
  return { transport };
}

beforeEach(() => {
  localStorage.clear();
  delete window.electronAPI;
  vi.stubGlobal('Notification', FakeNotification);
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = vi.fn().mockResolvedValue('granted');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('adding this device', () => {
  it('registers the worker, asks permission, and hands the subscription to the server', async () => {
    const { register, subscribe } = stubPushCapableBrowser();
    const registerPushSubscription = vi.fn().mockResolvedValue({
      ok: true,
      subscription: {
        id: 'push-1',
        service: 'fcm.googleapis.com',
        createdAt: '2026-08-20T09:00:00.000Z',
        lastSeenAt: '2026-08-20T09:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderSection({ registerPushSubscription });

    await user.click(await screen.findByRole('button', { name: 'Add this device' }));

    await waitFor(() => expect(registerPushSubscription).toHaveBeenCalled());
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    // Permission is asked from the click and never before it: a browser blocks a
    // request made without a gesture, and some hold it against the origin.
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.anything() })
    );
    expect(registerPushSubscription).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      keys: { p256dh: 'pub-key', auth: 'auth-key' },
    });
  });

  it('reuses a subscription the browser already has rather than making a second', async () => {
    const { subscribe } = stubPushCapableBrowser({ existing: browserSubscription() });
    const registerPushSubscription = vi.fn().mockResolvedValue({
      ok: true,
      subscription: {
        id: 'push-1',
        service: 'fcm.googleapis.com',
        createdAt: '2026-08-20T09:00:00.000Z',
        lastSeenAt: '2026-08-20T09:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderSection({ registerPushSubscription });

    await user.click(await screen.findByRole('button', { name: 'Add this device' }));

    await waitFor(() => expect(registerPushSubscription).toHaveBeenCalled());
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('says what a refused permission means, and stores nothing', async () => {
    stubPushCapableBrowser();
    FakeNotification.requestPermission = vi.fn().mockResolvedValue('denied');
    const registerPushSubscription = vi.fn();
    const user = userEvent.setup();
    renderSection({ registerPushSubscription });

    await user.click(await screen.findByRole('button', { name: 'Add this device' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/set to refuse notifications/);
    expect(registerPushSubscription).not.toHaveBeenCalled();
  });
});

describe('what the device list draws', () => {
  it('marks the row this browser subscribed, and never shows an endpoint', async () => {
    stubPushCapableBrowser();
    localStorage.setItem('dorkos.push.device-id', 'push-mine');
    renderSection({
      listPushSubscriptions: vi.fn().mockResolvedValue({
        subscriptions: [
          {
            id: 'push-mine',
            service: 'fcm.googleapis.com',
            createdAt: '2026-08-20T09:00:00.000Z',
            lastSeenAt: '2026-08-20T09:00:00.000Z',
          },
          {
            id: 'push-phone',
            service: 'web.push.apple.com',
            createdAt: '2026-08-20T08:00:00.000Z',
            lastSeenAt: '2026-08-20T08:00:00.000Z',
          },
        ],
      }),
    });

    expect(await screen.findByText('This device')).toBeInTheDocument();
    expect(screen.getByText('Another device (web.push.apple.com)')).toBeInTheDocument();
    // Already subscribed here, so the button would do nothing.
    expect(screen.queryByRole('button', { name: 'Add this device' })).not.toBeInTheDocument();
  });

  it('removes a device on request', async () => {
    stubPushCapableBrowser();
    const deletePushSubscription = vi.fn().mockResolvedValue({ ok: true, removed: 1 });
    const user = userEvent.setup();
    renderSection({
      deletePushSubscription,
      listPushSubscriptions: vi.fn().mockResolvedValue({
        subscriptions: [
          {
            id: 'push-phone',
            service: 'web.push.apple.com',
            createdAt: '2026-08-20T08:00:00.000Z',
            lastSeenAt: '2026-08-20T08:00:00.000Z',
          },
        ],
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(deletePushSubscription).toHaveBeenCalledWith('push-phone'));
  });
});

describe('the warning that nothing can carry an escalation', () => {
  it('waits for both lists before claiming nothing can carry it', async () => {
    // An empty device list means "none subscribed" and "not loaded yet" alike.
    // Flashing the warning off the second alarms somebody whose phone IS
    // subscribed, and the first thing they do is doubt the setting.
    stubPushCapableBrowser();
    let releaseDevices!: (value: { subscriptions: [] }) => void;
    renderSection({
      listPushSubscriptions: vi.fn().mockReturnValue(
        new Promise<{ subscriptions: [] }>((resolve) => {
          releaseDevices = resolve;
        })
      ),
    });

    // The section is on screen, but the device list has not answered yet.
    expect(await screen.findByText(/Devices DorkOS can reach/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing can carry that yet\./)).not.toBeInTheDocument();

    releaseDevices({ subscriptions: [] });
    expect(await screen.findByText(/Nothing can carry that yet\./)).toBeInTheDocument();
  });

  it('stays quiet once a device is subscribed', async () => {
    stubPushCapableBrowser();
    renderSection({
      listPushSubscriptions: vi.fn().mockResolvedValue({
        subscriptions: [
          {
            id: 'push-phone',
            service: 'web.push.apple.com',
            createdAt: '2026-08-20T08:00:00.000Z',
            lastSeenAt: '2026-08-20T08:00:00.000Z',
          },
        ],
      }),
    });

    expect(await screen.findByText(/Another device/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing can carry that yet\./)).not.toBeInTheDocument();
  });
});

describe('surfaces that cannot be pushed to', () => {
  it('offers no button in the desktop app, and says why', async () => {
    stubPushCapableBrowser();
    window.electronAPI = { getServerPort: () => 4242 } as unknown as ElectronAPI;
    const getPushVapidPublicKey = vi.fn();
    renderSection({ getPushVapidPublicKey });

    expect(await screen.findByText(/The desktop app is already running/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add this device' })).not.toBeInTheDocument();
    // Reading the key GENERATES the install's keypair, so a surface that cannot
    // use it must not ask for it.
    expect(getPushVapidPublicKey).not.toHaveBeenCalled();
  });

  it('offers no button on a browser with no Push API', async () => {
    stubPushIncapableBrowser();
    renderSection();

    expect(
      await screen.findByText(/This browser cannot receive notifications/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add this device' })).not.toBeInTheDocument();
  });

  it('says so when the server has no keypair', async () => {
    stubPushCapableBrowser();
    renderSection({ getPushVapidPublicKey: vi.fn().mockResolvedValue({ key: null }) });

    expect(await screen.findByText(/could not set up push notifications/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add this device' })).not.toBeInTheDocument();
  });
});
