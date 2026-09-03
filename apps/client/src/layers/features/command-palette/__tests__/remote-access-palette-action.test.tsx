/**
 * @vitest-environment jsdom
 *
 * The four remote-access rows, dispatched (DOR-1743).
 *
 * `palette-remote-access.test.ts` proves the right ROWS are offered.
 * This proves each one does the thing its label promises — the gap where a
 * palette entry closes the dialog and nothing happens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { usePaletteActions } from '../model/use-palette-actions';
import { REMOTE_ACCESS_PALETTE_ACTIONS } from '../model/palette-remote-access';

const mockTransport = createMockTransport();

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/current', vi.fn()],
  useStartNewSession: () => vi.fn(),
}));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  const inertDeepLink = {
    isOpen: false,
    activeTab: null,
    section: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  };
  return {
    ...actual,
    useSettingsDeepLink: () => inertDeepLink,
    useTasksDeepLink: () => inertDeepLink,
    useOpenConnections: () => vi.fn(),
    useReportIssue: () => vi.fn(),
    useTransport: () => mockTransport,
  };
});

import { useAppStore } from '@/layers/shared/model';
import { resetRemoteAccessStore, useRemoteAccessStore } from '@/layers/entities/tunnel';

function mountActions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => usePaletteActions(vi.fn()), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRemoteAccessStore();
  useAppStore.setState({ remoteAccessBeaconOpen: false, remoteAccessOpen: false });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  useAppStore.setState({ remoteAccessBeaconOpen: false, remoteAccessOpen: false });
});

describe('remote-access palette actions', () => {
  it('copies the live link', async () => {
    act(() => useRemoteAccessStore.getState().settleStart('https://calm-otter.ngrok.app'));
    const { result } = mountActions();

    act(() => result.current.handleQuickAction(REMOTE_ACCESS_PALETTE_ACTIONS.copyLink));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://calm-otter.ngrok.app')
    );
  });

  it('copies nothing when there is nothing to copy', async () => {
    const { result } = mountActions();

    act(() => result.current.handleQuickAction(REMOTE_ACCESS_PALETTE_ACTIONS.copyLink));

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('opens the beacon flyout to show the QR code', () => {
    act(() => useRemoteAccessStore.getState().settleStart('https://calm-otter.ngrok.app'));
    const { result } = mountActions();

    act(() => result.current.handleQuickAction(REMOTE_ACCESS_PALETTE_ACTIONS.showQr));

    // The same store flag the beacon's own trigger flips, so ⌘K and a click
    // open one surface.
    expect(useAppStore.getState().remoteAccessBeaconOpen).toBe(true);
  });

  it('turns remote access on', async () => {
    vi.mocked(mockTransport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });
    const { result } = mountActions();

    act(() => result.current.handleQuickAction(REMOTE_ACCESS_PALETTE_ACTIONS.turnOn));

    await waitFor(() => expect(mockTransport.startTunnel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useRemoteAccessStore.getState().state).toBe('connected'));
  });

  it('turns remote access off', async () => {
    vi.mocked(mockTransport.stopTunnel).mockResolvedValue(undefined);
    act(() => useRemoteAccessStore.getState().settleStart('https://calm-otter.ngrok.app'));
    const { result } = mountActions();

    act(() => result.current.handleQuickAction(REMOTE_ACCESS_PALETTE_ACTIONS.turnOff));

    await waitFor(() => expect(mockTransport.stopTunnel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useRemoteAccessStore.getState().state).toBe('off'));
  });
});
