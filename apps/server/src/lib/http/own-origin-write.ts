/**
 * The page bar for the owner's device-trust writes (DOR-4744): approving a
 * Wi-Fi sign-in and letting a Wi-Fi device run agents.
 *
 * On top of the person bar each route applies, the request must:
 *
 * - **name one of this server's own origins in `Origin`**, exactly. The list is
 *   built from config and server state ({@link resolveTrustedOrigins}: this
 *   computer's addresses, the live tunnel, Wi-Fi while it is on), never from the
 *   request's `Host` or a forwarding header. No `Origin` at all is refused too:
 *   a browser always sends one on these requests.
 * - **carry a JSON body** (`Content-Type: application/json`), which a plain
 *   form on another page cannot send without asking first.
 *
 * @module lib/http/own-origin-write
 */
import type { RequestFacts } from '../../http/request-facts.js';
import { resolveTrustedOrigins } from '../trusted-origins.js';

/** Refusal code when a device-trust write did not come from the app's own page. */
export const NOT_FROM_OWN_PAGE = 'NOT_FROM_OWN_PAGE';

/**
 * Whether a write came from one of this server's own pages, as JSON.
 *
 * @param headers - The request's raw headers.
 * @param ownOrigins - This server's own origins; the live list when omitted.
 */
export function isOwnOriginJsonWrite(
  headers: RequestFacts['headers'],
  ownOrigins: readonly string[] = resolveTrustedOrigins()
): boolean {
  const origin = headers.origin;
  if (typeof origin !== 'string' || !ownOrigins.includes(origin)) return false;
  const type = headers['content-type'];
  if (typeof type !== 'string') return false;
  return type.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}
