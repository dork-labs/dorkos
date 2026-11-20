import { BrowserProfileRemoval } from './index.js';
import type { LocalBrowserPageSession } from '../leases/page-session.js';
import type { EmbeddedBrowserPort } from '../desktop-bridge.js';

/** Standalone page sessions use the same removal guard as the profile host supplies. */
export function pageSessionProfileRemoval(
  dataDirectory: string,
  session: LocalBrowserPageSession,
  embedded?: EmbeddedBrowserPort
): BrowserProfileRemoval {
  return new BrowserProfileRemoval({
    dataDirectory: () => dataDirectory,
    busy: (id) => session.holdsProfileReservation(id),
    forgotten: (id) => session.handover.forgetProfileState(id),
    embedded: () => embedded,
  });
}
