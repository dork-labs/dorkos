/**
 * The public (session/client/agent-facing) connected-account shape — the ONE
 * place an account is prepared to cross an outward surface: the server-only
 * `provider` field is stripped (gateway spec §Security Considerations) and the
 * account's plain-language custody sentence is attached (no client or agent
 * surface ever composes disclosure copy of its own). Shared by the REST routes
 * and the connector capabilities so the two DTOs cannot drift.
 *
 * @module services/connectors/public-account
 */
import type { ConnectedAccount, PublicConnectedAccount } from '@dorkos/shared/connector-provider';
import { disclosureForAccount } from './custody-disclosure.js';

export type { PublicConnectedAccount } from '@dorkos/shared/connector-provider';

/**
 * Strip the server-only `provider` field and attach the server-composed
 * custody sentence before an account crosses to a client or an agent.
 *
 * @param account - The full server-side account.
 */
export function toPublicAccount(account: ConnectedAccount): PublicConnectedAccount {
  const { provider: _provider, ...rest } = account;
  return { ...rest, disclosure: disclosureForAccount(account) };
}
