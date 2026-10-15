/** Local browser availability and findable setup instructions. */
import type { LocalBrowserCapabilities } from '@dorkos/shared/local-browser';
import {
  LOCAL_PLAYWRIGHT_VERSION,
  LOCAL_MANAGED_CHROMIUM_VERSION,
  LOCAL_EXISTING_BROWSER_VERSIONS,
} from './playwright-backend.js';
/** Describe the modes this local install can present and the browser’s own setup steps. */
export function localBrowserCapabilities(embedded: boolean): LocalBrowserCapabilities {
  const local = ['darwin', 'win32', 'linux'].includes(process.platform);
  return {
    platform: process.platform,
    managedChromiumVersion: LOCAL_MANAGED_CHROMIUM_VERSION,
    existingBrowserVersions: LOCAL_EXISTING_BROWSER_VERSIONS,
    unavailableReasons: {
      ...(!embedded && { embedded: 'Use the DorkOS desktop app.' }),
      ...(!local && {
        'new-window': 'Available on your DorkOS computer.',
        existing: 'Available on your DorkOS computer.',
      }),
    },
    embedded: embedded,
    newWindow: local,
    existing: local,
    playwrightVersion: LOCAL_PLAYWRIGHT_VERSION,
    defaultMode: embedded ? 'embedded' : 'new-window',
    existingSetup: [
      {
        channel: 'chrome',
        name: 'Chrome',
        address: 'chrome://inspect/#remote-debugging',
        steps: [
          'Open this address in Chrome.',
          'Turn on “Allow remote debugging”.',
          'This lets DorkOS use your chosen browser.',
          'Allow the connection when Chrome asks.',
        ],
      },
      {
        channel: 'msedge',
        name: 'Edge',
        address: 'edge://inspect/#remote-debugging',
        steps: [
          'Open this address in Edge.',
          'Turn on “Allow remote debugging”.',
          'This lets DorkOS use your chosen browser.',
          'Allow the connection when Edge asks.',
        ],
      },
    ],
  };
}
