/**
 * Whether a connected account can be given to an agent right now, and when it
 * cannot, the one thing standing in the way. The server refuses to answer an
 * agent's request with an account that is paused, signed out or still being
 * set up, so the chat card asks for the fix first rather than offering an
 * Allow that cannot land.
 *
 * @module features/connections/lib/account-readiness
 */
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';

/** What an account needs before an agent can use it. */
export type AccountAttention =
  { kind: 'paused' } | { kind: 'signed_out' } | { kind: 'setting_up' } | { kind: 'needs_review' };

/**
 * `null` when the account is usable now; otherwise what it needs.
 *
 * @param connection - The account as the owner's list reports it.
 */
export function accountAttention(connection: ConnectorConnectionSummary): AccountAttention | null {
  if (connection.lifecycle === 'paused') return { kind: 'paused' };
  if (connection.authenticationStatus !== 'active') return { kind: 'signed_out' };
  if (connection.authoritySync.status === 'failed') return { kind: 'needs_review' };
  if (connection.reconciliationStatus !== 'ready') return { kind: 'needs_review' };
  if (connection.authoritySync.status === 'pending') return { kind: 'setting_up' };
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
