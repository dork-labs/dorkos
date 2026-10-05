/**
 * Where the page that finishes connecting an account should send the person
 * back to: the Connections page, on whichever surface they started from.
 *
 * - **Desktop app:** a `dorkos://connections` link. The finishing page opens in
 *   the system browser, and the link brings the app forward on Connections
 *   (`parseDeepLink` in `apps/desktop/src/main/navigation.ts`).
 * - **Browser:** this page's own origin plus `/connections`, so a person on
 *   `localhost` or on their tunnel address returns to that same address.
 *
 * The server keeps the value only when it leads back to an address it serves,
 * so this is a request, not an instruction.
 *
 * @module entities/connectors/lib/connect-return-to
 */
import { isDesktopShell } from '@/layers/shared/lib';

/** The app route a finished connection returns to. */
const CONNECTIONS_ROUTE = 'connections';

/**
 * The link a connection start sends as its way back into the app.
 *
 * @returns `dorkos://connections` in the desktop app, else this origin's Connections page.
 */
export function connectReturnTo(): string {
  if (isDesktopShell()) return `dorkos://${CONNECTIONS_ROUTE}`;
  return `${window.location.origin}/${CONNECTIONS_ROUTE}`;
}
