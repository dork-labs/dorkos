/**
 * Keeps the tab set in step with the router's location.
 *
 * The single reconciliation point for every navigation the cockpit performs,
 * whatever started it: a click, the command palette, a `dorkos://` deep link,
 * a route loader's redirect, or the Back button. That is what makes tabs a
 * consistent view of where you are instead of a second, drifting source of
 * truth — see the rule in `shared/model/app-tabs/app-tabs-store`.
 *
 * It also tells the reconciler **how** the location changed. Only a history
 * traversal — Back, Forward, or a multi-step jump — may move focus to another
 * tab; every other navigation belongs to the tab you are already in. Without that distinction,
 * closing a `?settings=open` dialog while a second tab sits at the same
 * pathname teleports you into that tab, and opening a tab on an agent another
 * tab already shows strands the new one. The router's own history reports the
 * action type, so this reads it from the source rather than inferring it from
 * hrefs.
 *
 * **Desktop shell only** (DOR-568). Tabs are a desktop feature — a browser
 * already has tabs — so outside the shell there is no tab set to reconcile and
 * this writes nothing, which also keeps the store's `sessionStorage` mirror
 * untouched there. The shell mounts it unconditionally (Rules of Hooks); the
 * gate is inside the effects.
 *
 * @module features/app-tabs/model/use-app-tabs-sync
 */
import { useEffect, useRef } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { isDesktopShell } from '@/layers/shared/lib';
import { useAppTabsStore } from '@/layers/shared/model';

/** Reconcile the tab set on every location change. Mounted once, by the shell. */
export function useAppTabsSync(): void {
  const router = useRouter();
  const href = useRouterState({ select: (s) => s.location.href });

  // Set by the history subscriber, read by the location effect below. Both run
  // within one commit: `history.notify()` calls its subscribers synchronously —
  // the router's first, then this one — and React does not run passive effects
  // until after it commits the resulting render, so the flag is current by the
  // time the location effect reads it. Assigned (never OR-ed) on every
  // notification, so a traversal that lands on the href we are already on
  // cannot leave a stale `true` for the next push to trip over.
  const traversed = useRef(false);

  useEffect(() => {
    if (!isDesktopShell()) return;
    return router.history.subscribe(({ action }) => {
      // Defined as "not a new entry" rather than as a list of the traversals we
      // thought of. `@tanstack/history` reports `GO` for any popstate whose
      // delta is not exactly ±1 — jumping three back through the Back button's
      // context menu, say — so an allowlist of BACK/FORWARD silently drops
      // multi-step traversals and lets the active tab overwrite itself with an
      // old location. Only PUSH and REPLACE create a new entry; everything
      // else, present or future, moved through history.
      traversed.current = action.type !== 'PUSH' && action.type !== 'REPLACE';
    });
  }, [router]);

  useEffect(() => {
    if (!isDesktopShell()) return;
    const traversal = traversed.current;
    traversed.current = false;
    // Read imperatively: this hook only writes, so subscribing to the store
    // would re-render the shell on every tab change for nothing.
    useAppTabsStore.getState().syncLocation(href, { traversal });
  }, [href]);
}
