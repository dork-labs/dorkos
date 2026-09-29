/**
 * What an own-key disconnect still owes at the service, shared by the owner
 * lifecycle (which tries it) and sign-ins (which must not cancel a try in
 * flight): the retry schedule, which tries are running, which ways hold a
 * sign-in at a service at all, and how a stored cleanup state reads.
 *
 * @module services/connectors/resources/owed-cleanup
 */
import type { Db } from '@dorkos/db';
import type { ConnectorLifecycleResult } from '@dorkos/shared/connector-resource-schemas';

/**
 * How long DorkOS waits before trying again to remove an own-key account's
 * access at the service, one entry per failed try in a row. After the last,
 * it stops trying on its own: the person is shown how to end the access in
 * the service's own settings, and can remove the account from their apps.
 */
export const CLEANUP_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

// Own-key cleanups being tried right now, so the background retry and a
// "Try again now" never send the same delete twice at once.
const cleanupsInFlight = new WeakMap<Db, Set<string>>();

/**
 * The own-key cleanups being tried right now against one database.
 *
 * @param db - The connector database the tries run against.
 */
export function inFlight(db: Db): Set<string> {
  let running = cleanupsInFlight.get(db);
  if (!running) {
    running = new Set();
    cleanupsInFlight.set(db, running);
  }
  return running;
}

/**
 * Whether DorkOS is trying to end one own-key account's access at the service
 * right now, so a new sign-in to that same account must not cancel it yet.
 *
 * @param db - The connector database the try runs against.
 * @param connectionId - The disconnected account.
 */
export function cleanupInFlight(db: Db, connectionId: string): boolean {
  return inFlight(db).has(connectionId);
}

/**
 * A stored cleanup state as a result reports it: `unknown` (unconfirmed) reads as failed.
 *
 * @param state - The stored cleanup state.
 */
export function publicCleanup(
  state: 'not_required' | 'pending' | 'complete' | 'failed' | 'unknown'
): ConnectorLifecycleResult['externalCleanup'] {
  return state === 'unknown' ? 'failed' : state;
}

/**
 * Whether an own-key way leaves a sign-in at a service that only the same key
 * can end. A way whose custody is `external` keeps no sign-in at all (raw MCP:
 * disconnecting it is local), so which key it was reached through doesn't
 * matter and its end is never unconfirmed.
 *
 * @param row - The account's way: its mode and custody.
 */
export function holdsSignInAtService(row: {
  mode: 'managed' | 'byo';
  custody: 'managed' | 'self-host' | 'external';
}): boolean {
  return row.mode === 'byo' && row.custody !== 'external';
}
