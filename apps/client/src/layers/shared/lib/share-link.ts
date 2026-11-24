/**
 * The full link a "Copy link" puts on the clipboard.
 *
 * - **Browser and phone:** this page's own origin plus the app path, so a person
 *   on `localhost` or on their tunnel address shares that same address.
 * - **Desktop app:** a `dorkos://` link (`dorkos://r/dork:chat:…`). The
 *   renderer's own origin is a localhost port the bundled server picked for this
 *   launch, so an `http` link would stop working after a restart; a `dorkos://`
 *   link opens the app on that page from anywhere on this computer
 *   (`parseDeepLink` in `apps/desktop/src/main/navigation.ts`). The dashboard is
 *   the exception: a deep link needs a first path segment to carry, and `/` has
 *   none, so it falls back to the origin link.
 *
 * The same split as `connectReturnTo` in `entities/connectors`. A tab's Copy
 * link and the Copy link on a chat, a room message and an agent (DOR-5046) all
 * build their link here.
 *
 * @module shared/lib/share-link
 */
import { DORK_LINK_PREFIX, dorkReferenceOrNull, type DorkKind } from '@dorkos/shared/dork-ref';
import { isDesktopShell } from './platform';

/**
 * A full, shareable link to a page of the app.
 *
 * @param href - The router-relative location, e.g. `/session?session=abc`.
 * @returns A `dorkos://` link in the desktop app when the page has a path to
 *   carry, else an absolute link on this page's origin.
 */
export function shareableAppUrl(href: string): string {
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

/**
 * The full `/r/` link to a chat, room, message or agent: the one link every
 * DorkOS origin answers (ADR 261122-124821), so it keeps naming the same thing
 * wherever it is opened.
 *
 * @param kind - What kind of thing the link names.
 * @param id - Its id, exactly as held.
 * @returns `<origin>/r/dork:<kind>:<id>` (`dorkos://r/…` in the desktop app),
 *   or `null` when the id cannot be a `dork:` reference, so a caller offers no
 *   Copy link rather than one that copies nothing.
 */
export function dorkShareUrl(kind: DorkKind, id: string): string | null {
  const ref = dorkReferenceOrNull(kind, id);
  return ref === null ? null : shareableAppUrl(`${DORK_LINK_PREFIX}${ref}`);
}
