/**
 * The link "Copy link" puts on the clipboard for a tab.
 *
 * - **Browser:** this page's own origin plus the tab's location, so a person on
 *   `localhost` or on their tunnel address shares that same address.
 * - **Desktop app:** a `dorkos://` link (`dorkos://session?session=…`). The
 *   renderer's own origin is a localhost port the bundled server picked for this
 *   launch, so an `http` link would stop working after a restart; a `dorkos://`
 *   link opens the app on that page from anywhere on this computer
 *   (`parseDeepLink` in `apps/desktop/src/main/navigation.ts`). The dashboard is
 *   the exception: a deep link needs a first path segment to carry, and `/` has
 *   none, so it falls back to the origin link.
 *
 * The same split as `connectReturnTo` in `entities/connectors`.
 *
 * @module features/app-tabs/lib/tab-link
 */
import { isDesktopShell } from '@/layers/shared/lib';

/**
 * A full, shareable link to a tab's page.
 *
 * @param href - The tab's router-relative location, e.g. `/session?session=abc`.
 * @returns A `dorkos://` link in the desktop app when the page has a path to
 *   carry, else an absolute link on this page's origin.
 */
export function tabLinkUrl(href: string): string {
  const path = href.startsWith('/') ? href : `/${href}`;
  if (isDesktopShell()) {
    const rest = path.slice(1);
    // `?…` or `#…` straight after the slash means there is no host to put in
    // `dorkos://<host>`, and a bare `dorkos://` only focuses the window.
    if (rest.length > 0 && !rest.startsWith('?') && !rest.startsWith('#')) {
      return `dorkos://${rest}`;
    }
  }
  return `${window.location.origin}${path}`;
}
