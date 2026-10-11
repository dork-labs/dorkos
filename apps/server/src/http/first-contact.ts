/**
 * One-shot "first contact" log lines, shared by both chains.
 *
 * @module http/first-contact
 */
import { logger } from '../lib/logger.js';

/**
 * Build a one-shot `info` marker: the returned function logs `message` the
 * first time it is called and does nothing on every call after that.
 *
 * This closes a diagnostic blind spot that cost a day of an incident.
 * Successful requests are logged at `debug`, so a user's log at the default
 * level contains nothing at all when everything is working — which means it
 * cannot answer the first question a blank window raises: did the cockpit ever
 * reach the server, or is this a server that never came up? One `info` line
 * apiece for the first shell served and the first API call answers it outright,
 * without touching what the request logger does per request.
 *
 * The latch is a closure rather than module state so it is scoped to one
 * chain — i.e. to one boot, which is what "first" means here — and so a
 * test can prove the once-only behaviour by building two apps.
 *
 * @param message - The line to log, tagged the way `lib/logger.ts` expects.
 */
export function createFirstContactMarker(message: string): () => void {
  let logged = false;
  return () => {
    if (logged) return;
    logged = true;
    logger.info(message);
  };
}
