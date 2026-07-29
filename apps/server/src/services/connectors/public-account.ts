/**
 * The public (session/client/agent-facing) connected-account shape — the ONE
 * place the server-only `provider` field is stripped before an account crosses
 * any outward surface (gateway spec §Security Considerations). Shared by the
 * REST routes and the connector capabilities so the two DTOs cannot drift.
 *
 * @module services/connectors/public-account
 */
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';

/** A connected account with the server-only `provider` field removed. */
export type PublicConnectedAccount = Omit<ConnectedAccount, 'provider'>;

/**
 * Strip the server-only `provider` field before an account crosses to a client
 * or an agent.
 *
 * @param account - The full server-side account.
 */
export function toPublicAccount(account: ConnectedAccount): PublicConnectedAccount {
  const { provider: _provider, ...rest } = account;
  return rest;
}
