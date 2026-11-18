import { useCallback } from 'react';
import { useRouter } from '@tanstack/react-router';

import type { AppLocation } from '../../lib/session-navigation-intent';

/** Where a subtree with no router stands: nowhere, so nothing can move it. */
const NO_ROUTER_LOCATION: AppLocation = { pathname: '', search: {} };

/**
 * A reader of the router's LIVE location, called at the moment it is needed
 * rather than captured at render.
 *
 * For navigations that resolve late — after a server answer, a POST, a stream
 * event — where the only honest question is where the window is NOW: a tab
 * switch or a sidebar click in the meantime means the navigation must not land
 * (DOR-4622). Pass it to `beginSessionNavigation`, or read it directly.
 *
 * Tolerates a missing RouterProvider (isolated previews, hook tests), the
 * `useSafeSearch` way: there is no location there to have changed.
 *
 * @returns A stable function reading the current location.
 */
export function useLiveLocation(): () => AppLocation {
  const router = useRouter({ warn: false });
  return useCallback(() => (router ? router.state.location : NO_ROUTER_LOCATION), [router]);
}
