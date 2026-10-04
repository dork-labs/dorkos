/**
 * Moving the window to whatever tab is active — the one place that turns a tab
 * change into a navigation, shared by the React actions ({@link useAppTabActions})
 * and the link seam's tab opener, which is registered from the app entry and
 * runs outside React.
 *
 * Both go through here so the reconciliation is written once. Two call sites
 * with their own copy of "navigate, then check where we landed" is exactly how
 * the headline path would drift away from the rest.
 *
 * @module features/app-tabs/model/tab-navigation
 */
import { useAppTabsStore } from '@/layers/shared/model';

/**
 * The slice of the TanStack router this module needs: somewhere to go, and a
 * way to ask where we actually ended up. Narrow on purpose — the app entry
 * passes the real router, and a test can stand one up in three lines.
 */
export interface TabRouter {
  /** Navigate to a relative href. Settles once loaders and redirects are done. */
  navigate: (options: { href: string }) => Promise<void>;
  /** Live router state, read after a navigation settles. */
  state: { location: { href: string } };
}

/**
 * Navigate to the active tab's location, then reconcile the tab set against
 * where the router actually landed.
 *
 * The second half is not belt-and-braces. A route loader can redirect — the
 * `/session` loader turns `?dir=…` into a concrete session — and when that
 * redirect resolves to the location the router was **already** on, no location
 * change fires, so `useAppTabsSync` never runs and the tab keeps an href its
 * own loader redirects away from every time it is opened. Calling the same
 * `syncLocation` here closes that hole; when the location did change, the sync
 * effect got there first and this is a no-op.
 *
 * It reconciles as a **replace**: the only way to land somewhere other than the
 * tab's href is a redirect of that very page, so the tab's current history entry
 * is rewritten rather than a second one added (DOR-2107). Otherwise a fresh tab
 * on `/session?dir=…` would keep that transient href behind it, and Back would
 * walk straight into the same redirect.
 *
 * @param router - The router to drive.
 */
export function goToActiveTab(router: TabRouter): void {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (!active) return;
  const { id, href } = active;
  void router.navigate({ href }).then(() => {
    // Only for the tab and page this navigation was for. If the person switched
    // tabs or went somewhere else while it settled, the location belongs to
    // that later move, and writing it here would overwrite the wrong entry.
    const now = useAppTabsStore.getState();
    const still = now.tabs.find((tab) => tab.id === now.activeTabId);
    if (still?.id !== id || still.href !== href) return;
    now.syncLocation(router.state.location.href, { replace: true });
  });
}

/**
 * Open `href` in a new tab and go to it — the one implementation behind the
 * strip's "+", `Cmd/Ctrl+T`, and every `target: 'tab'` link.
 *
 * @param router - The router to drive.
 * @param href - Router-relative location for the new tab.
 */
export function openTabAt(router: TabRouter, href: string): void {
  useAppTabsStore.getState().openTab(href);
  goToActiveTab(router);
}
