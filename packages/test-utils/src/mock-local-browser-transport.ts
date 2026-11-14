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
    handoff: null,
    signIn: null,
  };
  return {
    scanYourBrowsers: vi.fn().mockResolvedValue({ supported: true, profiles: [], unreadable: [] }),
    getLocalBrowserState: vi.fn().mockResolvedValue(state),
    listLocalBrowserProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
    forgetLocalBrowserSignIns: vi.fn().mockResolvedValue({ success: true }),
    deleteLocalBrowserProfile: vi.fn().mockResolvedValue({ success: true }),
    getLocalBrowserCapabilities: vi.fn().mockResolvedValue({
      embedded: false,
      newWindow: false,
      platform: 'darwin',
      managedChromiumVersion: '157.0.8103.15',
      unavailableReasons: {},
      playwrightVersion: '',
      defaultMode: 'new-window',
    }),
    openLocalBrowser: vi.fn().mockRejectedValue(new Error('Browser unavailable')),
    closeIdleLocalBrowserTab: vi.fn().mockResolvedValue(state),
    selectLocalBrowserTab: vi.fn().mockRejectedValue(new Error('Browser unavailable')),
    navigateLocalBrowser: vi.fn().mockRejectedValue(new Error('Browser unavailable')),
    pauseLocalBrowser: vi.fn().mockResolvedValue({ ...state, paused: true }),
    resumeLocalBrowser: vi.fn().mockResolvedValue(state),
    disconnectLocalBrowser: vi.fn().mockResolvedValue(state),
    signInLocalBrowser: vi.fn().mockRejectedValue(new Error('Browser unavailable')),
    handBackLocalBrowser: vi.fn().mockRejectedValue(new Error('Browser unavailable')),
    stopLocalBrowserHandoff: vi.fn().mockRejectedValue(new Error('Browser unavailable')),
  };
}
