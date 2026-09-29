/**
 * Names and colors a Claude account by its registry id, the one way the
 * banner and the transcript marker name the accounts a limit involves.
 *
 * @module features/continue-on-account/model/use-account-namer
 */
import { IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { accountIdentity } from '@/layers/shared/lib';
import { useAccountUsageRecord, useClaudeAccounts } from '@/layers/shared/model';

/** An account as a sentence names it, with its dot. */
export interface NamedAccount {
  /** The app's name for it. */
  name: string;
  /** Its color, or `null` when unknown. */
  color: string | null;
}

/**
 * A function that names a Claude account by its registry id through the
 * shared naming helper (`accountIdentity`), so this computer's own sign-in
 * reads "Main (this computer's sign-in)" here as everywhere (decision §12).
 * Reads the config and the usage cache the session list seeds; never fetches.
 */
export function useAccountNamer(): (accountId: string) => NamedAccount {
  const { accounts, nameFor, colorFor } = useClaudeAccounts();
  // The standalone default is named by the host's label on its reading.
  const defaultReading = useAccountUsageRecord('claude-code', {
    accountId: IMPLICIT_ACCOUNT_ID,
    path: null,
  });
  return (accountId) => {
    const identity = accountIdentity({
      accountId,
      path: null,
      accounts,
      usage: accountId === IMPLICIT_ACCOUNT_ID ? defaultReading : null,
      nameFor,
      colorFor,
    });
    return { name: identity.name ?? accountId, color: identity.color };
  };
}
