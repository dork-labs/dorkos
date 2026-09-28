/**
 * Whether a connected account can be given to an agent right now, and when it
 * cannot, the one thing standing in the way. The server refuses to answer an
 * agent's request with an account that is paused, signed out or waiting on a
 * review of its actions, and no agent can use one whose way is down, so the chat card asks for the fix first rather than
 * offering an Allow that cannot land.
 *
 * Deliberately NOT read here: the summary's `authoritySync`. It spans every
 * agent's access on the account, so another agent's pending or failed change
 * would block an account that is perfectly usable for this one. Whether THIS
 * agent's access has finished applying is the shared card's own "Check sync
 * status", and the server checks it per agent when the request is answered.
 *
 * @module features/connections/lib/account-readiness
 */
import type {
  ConnectorConnectionSummary,
  ConnectorWayProblem,
} from '@dorkos/shared/connector-resource-schemas';

/** What an account needs before an agent can use it. */
export type AccountAttention =
  | { kind: 'way_down'; problem: ConnectorWayProblem }
  | { kind: 'paused' }
  | { kind: 'signed_out' }
  | { kind: 'needs_review' };

/**
 * `null` when the account is usable now; otherwise what it needs. The way it
 * was connected through comes first: while that is down (an unlinked DorkOS
 * account, a key that stopped working), no other fix makes it usable.
 *
 * @param connection - The account as the owner's list reports it.
 */
export function accountAttention(connection: ConnectorConnectionSummary): AccountAttention | null {
  if (connection.wayProblem) return { kind: 'way_down', problem: connection.wayProblem };
  if (connection.lifecycle === 'paused') return { kind: 'paused' };
  if (connection.authenticationStatus !== 'active') return { kind: 'signed_out' };
  if (connection.reconciliationStatus !== 'ready') return { kind: 'needs_review' };
  return null;
}

/**
 * The accounts of one app an agent could be given right now.
 *
 * @param connections - The owner's accounts.
 * @param toolkit - The app's slug.
 */
export function usableAccounts(
  connections: readonly ConnectorConnectionSummary[],
  toolkit: string
): ConnectorConnectionSummary[] {
  return connections.filter(
    (connection) =>
      connection.toolkit === toolkit &&
      connection.lifecycle === 'connected' &&
      accountAttention(connection) === null
  );
}
