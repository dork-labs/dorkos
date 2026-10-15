import { vi } from 'vitest';
import type { LocalBrowserTransport } from '@dorkos/shared/transport-local-browser';

/** Browser control stays unavailable unless a test explicitly supplies a supported local host. */
export function createMockLocalBrowserTransport(): LocalBrowserTransport {
  const state = {
    connectionId: null,
    sessionId: null,
    mode: null,
    status: 'disconnected',
    paused: false,
    tabs: [],
    selectedTabId: null,
    revision: 0,
    preparation: null,
  };
  return {
    getLocalBrowserState: vi.fn().mockResolvedValue(state),
    getLocalBrowserCapabilities: vi.fn().mockResolvedValue({
      embedded: false,
      newWindow: false,
      platform: 'darwin',
      managedChromiumVersion: '153.0.8010.12',
      unavailableReasons: {},
      playwrightVersion: '',
      defaultMode: 'new-window',
    }),
    openLocalBrowser: vi.fn().mockRejectedValue(new Error('Browser unavailable')),
    selectLocalBrowserTab: vi.fn().mockRejectedValue(new Error('Browser unavailable')),
    navigateLocalBrowser: vi.fn().mockRejectedValue(new Error('Browser unavailable')),
    pauseLocalBrowser: vi.fn().mockResolvedValue({ ...state, paused: true }),
    resumeLocalBrowser: vi.fn().mockResolvedValue(state),
    disconnectLocalBrowser: vi.fn().mockResolvedValue(state),
  };
}
