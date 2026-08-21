/**
 * Switching the Claude Code account from the status bar.
 *
 * The account decides which client's subscription a turn bills to, and the
 * operator changes it several times a day, so the choice lives where a turn is
 * initiated and not only in Settings (spec `claude-code-accounts` D6).
 *
 * @module features/status/model/use-account-switch
 */
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { claudeAccountOptions, type ClaudeAccountRef } from '@/layers/shared/lib';
import { useClaudeAccounts } from '@/layers/shared/model';
import { useUpdateConfig } from '@/layers/entities/config';

/**
 * Stands in for "no account chosen", which writes `defaultAccount: null`. Radix
 * refuses an empty-string radio value, so the absence needs a spelling.
 */
export const DEFAULT_ACCOUNT_VALUE = '__default__';

/** What {@link useAccountSwitch} hands the status-bar menu. */
export interface AccountSwitch {
  /**
   * The accounts to offer, in the order the operator added them, plus the one in
   * use if it was never registered — otherwise the menu would have no item
   * matching its own value and nothing would look selected.
   *
   * Each carries `isAccountRoot`, so the menu can mark an account the server
   * cannot find rather than offering it as if it were ready.
   */
  accounts: ClaudeAccountRef[];
  /** The radio value currently selected: an account path, or the default sentinel. */
  selectedValue: string;
  /** Whether a switcher is worth showing at all (more than one account registered). */
  isMultiAccount: boolean;
  /** Short display name for an account path. */
  nameFor: (path: string) => string;
  /** Path a new session runs on right now, for the default option's hint text. */
  resolvedAccount: string | undefined;
  /** True when nobody chose the resolved account. */
  inherited: boolean;
  /** Select an account (or the sentinel) and persist it. */
  choose: (value: string) => void;
}

/**
 * Read the registered Claude accounts and switch which one new work runs on.
 *
 * A refusal is surfaced, never swallowed: `runtimes.claudeCode.defaultAccount` is
 * `operator-only`, so under Require login this write needs an operator session
 * cookie and answers 403 without one. The status bar has no room for an inline
 * error, so the toast carries the server's own sentence.
 */
export function useAccountSwitch(): AccountSwitch {
  const { accounts, resolvedAccount, inherited, isMultiAccount, nameFor } = useClaudeAccounts();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();

  const choose = (value: string) => {
    const defaultAccount = value === DEFAULT_ACCOUNT_VALUE ? null : value;
    updateConfig.mutate(
      { runtimes: { claudeCode: { defaultAccount } } },
      {
        onSuccess: () => {
          // The `['config']` PREFIX: the settings tabs read the bare key while
          // this menu and the sidebar badges read `['config','current']`.
          void queryClient.invalidateQueries({ queryKey: ['config'] });
        },
        onError: (err) => {
          // The server's own sentence, same as the settings card's
          // `describeWriteFailure`: it already refuses in plain words, and a
          // second wording of ours would drift from the guard. The fallback is
          // only for a transport that throws without a message at all.
          toast.error(
            (err instanceof Error && err.message) || 'Could not switch account. Try again.'
          );
        },
      }
    );
  };

  return {
    accounts: claudeAccountOptions(accounts, inherited ? null : resolvedAccount),
    selectedValue: inherited || !resolvedAccount ? DEFAULT_ACCOUNT_VALUE : resolvedAccount,
    isMultiAccount,
    nameFor,
    resolvedAccount,
    inherited,
    choose,
  };
}
