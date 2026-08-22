/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { createAppRouter } from '../router';
import { HOME_TABS } from '@/layers/shared/config';

/** The shipped route tree, built the way `main.tsx` builds it. */
function router() {
  return createAppRouter(new QueryClient(), createMockTransport() as Transport);
}

describe('the home surface route tree', () => {
  it('hangs every tab’s route off the home layout', () => {
    const routesByPath = router().routesByPath as Record<string, { parentRoute?: { id: string } }>;

    for (const tab of HOME_TABS) {
      expect(routesByPath[tab.path]?.parentRoute?.id, `${tab.path} is not a home-surface tab`).toBe(
        '/_shell/_home'
      );
    }
  });

  it('leaves routes outside the home surface where they were', () => {
    const routesByPath = router().routesByPath as Record<string, { parentRoute?: { id: string } }>;

    // The tab bar must not appear over a page that is not one of its tabs.
    for (const path of ['/session', '/team', '/channels', '/marketplace']) {
      expect(routesByPath[path]?.parentRoute?.id, `${path} was pulled into the home surface`).toBe(
        '/_shell'
      );
    }
  });
});
