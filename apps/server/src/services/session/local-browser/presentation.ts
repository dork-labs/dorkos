/** Availability of the two DorkOS-owned browser surfaces. */
import type {
  LocalBrowserCapabilities,
  LocalBrowserPersonState,
} from '@dorkos/shared/local-browser';
import { LOCAL_PLAYWRIGHT_VERSION, LOCAL_MANAGED_CHROMIUM_VERSION } from './playwright-backend.js';
export interface LocalBrowserHostFacts {
  platform: NodeJS.Platform;
  display?: string;
  waylandDisplay?: string;
}

/** No selected page or handoff; constructing an owner read never creates a lease. */
export function emptyBrowserPersonState(): LocalBrowserPersonState {
  return {
    preparation: null,
    connectionId: null,
    sessionId: null,
    mode: null,
    status: 'disconnected',
    paused: false,
    tabs: [],
    selectedTabId: null,
    revision: 0,
    handoff: null,
    signIn: null,
    takenOver: false,
  };
}

/** Read only the graphical host hints required for a headed browser window. */
export function localBrowserHostFacts(): LocalBrowserHostFacts {
  // eslint-disable-next-line no-restricted-syntax -- These are graphical host facts, not DorkOS configuration or secrets.
  const hostEnvironment = process.env;
  return {
    platform: process.platform,
    display: hostEnvironment.DISPLAY,
    waylandDisplay: hostEnvironment.WAYLAND_DISPLAY,
  };
}

/** Prefer the embedded desktop page; offer a separate visible window on a graphical host. */
export function localBrowserCapabilities(
  embedded: boolean,
  host: LocalBrowserHostFacts = localBrowserHostFacts()
): LocalBrowserCapabilities {
  const local = ['darwin', 'win32', 'linux'].includes(host.platform);
  const graphical =
    local &&
    (host.platform !== 'linux' || Boolean(host.display?.trim() || host.waylandDisplay?.trim()));
  return {
    platform: host.platform,
    managedChromiumVersion: LOCAL_MANAGED_CHROMIUM_VERSION,
    unavailableReasons: {
      ...(!embedded && { embedded: 'Use the DorkOS desktop app.' }),
      ...(!graphical && {
        'new-window': local
          ? 'Open DorkOS on a computer with a display.'
          : 'Available on your DorkOS computer.',
      }),
    },
    embedded: embedded,
    newWindow: graphical,
    playwrightVersion: LOCAL_PLAYWRIGHT_VERSION,
    defaultMode: embedded ? 'embedded' : 'new-window',
  };
}
