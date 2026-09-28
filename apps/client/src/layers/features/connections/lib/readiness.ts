/**
 * How the Connections surfaces read the server's `ConnectionReadiness`. The
 * server decides whether agents can use an account and what its one fix is;
 * nothing here looks at an account's raw fields.
 *
 * @module features/connections/lib/readiness
 */
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';

/**
 * The accounts of one app an agent can be given right now: the ready ones,
 * plus those whose only problem is a change to who can use them that is
 * still applying or didn't go through. That change spans every agent's
 * access on the account, and answering this request applies this agent's own
 * access afresh, so it doesn't stand in the way here.
 *
 * @param connections - The owner's accounts.
 * @param toolkit - The app's slug.
 */
export function offerableAccounts(
  connections: readonly ConnectorConnectionSummary[],
  toolkit: string
): ConnectorConnectionSummary[] {
  return connections.filter(
    (connection) =>
      connection.toolkit === toolkit &&
      (connection.readiness.state === 'ready' ||
        connection.readiness.reason === 'access_updating' ||
        connection.readiness.reason === 'access_update_failed')
  );
}
