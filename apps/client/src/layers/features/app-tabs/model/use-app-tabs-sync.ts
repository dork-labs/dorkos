/**
 * Keeps the tab set in step with the router's location.
 *
 * The single reconciliation point for every navigation the cockpit performs,
 * whatever started it: a click, the command palette, a `dorkos://` deep link,
 * a route loader's redirect, or the Back button. That is what makes tabs a
 * consistent view of where you are instead of a second, drifting source of
 * truth — see the rule in `shared/model/app-tabs-store`.
 *
 * @module features/app-tabs/model/use-app-tabs-sync
 */
import { useEffect } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useAppTabsStore } from '@/layers/shared/model';

/** Reconcile the tab set on every location change. Mounted once, by the shell. */
export function useAppTabsSync(): void {
  const href = useRouterState({ select: (s) => s.location.href });

  useEffect(() => {
    // Read imperatively: this hook only writes, so subscribing to the store
    // would re-render the shell on every tab change for nothing.
    useAppTabsStore.getState().syncLocation(href);
  }, [href]);
}
