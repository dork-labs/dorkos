import { useQuery } from '@tanstack/react-query';
import { claudeAccountName, type ClaudeAccountRef } from '../../lib/claude-accounts';
import { useTransport } from '../TransportContext';
import { configKeys, CONFIG_STALE_TIME_MS } from './query-keys';

/** What {@link useClaudeAccounts} reports. */
export interface ClaudeAccountsView {
  /**
   * The accounts the operator registered, in the order they registered them,
   * each carrying the server's `isAccountRoot` verdict. Keep that field: a
   * surface that OFFERS an account the server already flagged unusable has to say
   * so, or selecting it silently points new work at a signed-out config.
   */
  accounts: ClaudeAccountRef[];
  /**
   * Absolute path a NEW session runs and bills on, already resolved by the
   * server. `undefined` until the config lands, or on a server too old to
   * report it.
   */
  resolvedAccount: string | undefined;
  /** True when nobody chose the resolved account — the server inherited it. */
  inherited: boolean;
  /**
   * Whether more than one account is registered, which is the ONLY state where
   * naming accounts in the product earns its pixels: with one account (or none)
   * every session is on the same one, so a badge on every row would repeat a
   * fact that never varies.
   */
  isMultiAccount: boolean;
  /** The shortest honest name for an account path (label, else folder name). */
  nameFor: (path: string) => string;
}

/**
 * Read the Claude Code accounts the operator registered, and which one new work
 * runs on (spec `claude-code-accounts`).
 *
 * Lives in `shared/` on purpose, mirroring `useFeatureEnabled`: session rows
 * (`entities/session`) need this and may not import `entities/config`, so the
 * shared layer owns the one read both layers can reach. Reading through the
 * transport seam keeps the FSD hierarchy intact.
 */
export function useClaudeAccounts(): ClaudeAccountsView {
  const transport = useTransport();

  const { data } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

  const claudeCode = data?.claudeCode;
  const accounts = claudeCode?.accounts ?? [];

  return {
    accounts,
    resolvedAccount: claudeCode?.resolvedAccount,
    inherited: claudeCode?.inherited ?? true,
    isMultiAccount: accounts.length > 1,
    nameFor: (path: string) => claudeAccountName(path, accounts),
  };
}
