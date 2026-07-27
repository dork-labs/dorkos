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
 * @param router - The router to drive.
 */
export function goToActiveTab(router: TabRouter): void {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (!active) return;
  void router.navigate({ href: active.href }).then(() => {
    useAppTabsStore.getState().syncLocation(router.state.location.href);
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
