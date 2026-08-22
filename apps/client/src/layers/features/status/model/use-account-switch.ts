/**
 * Choosing the Claude Code account THIS session bills to, from the status bar.
 *
 * The account decides which client's subscription a turn spends, so the choice
 * belongs where a turn is initiated and not only in Settings (spec
 * `claude-code-accounts` D6). What it does there changed with the account ladder
 * (spec `billing-account-ladder`): picking an account here used to rewrite the
 * SERVER DEFAULT, so a one-off pick silently repointed every future session's
 * billing. It is now a launch hint for this session and nothing more — sent as
 * `account` on the session-creating first message, spent there, and gone.
 *
 * The three tiers each have exactly one home: the server default in Settings →
 * Runtimes, the agent's account in its "Runs on" popover, and this session's
 * pick here.
 *
 * @module features/status/model/use-account-switch
 */
import { claudeAccountName, type ClaudeAccountRef } from '@/layers/shared/lib';
import { useAppStore, useClaudeAccounts } from '@/layers/shared/model';

/**
 * Stands in for "no account picked", which sends NO hint and leaves the server's
 * ladder in charge. Radix refuses an empty-string radio value, so the absence
 * needs a spelling.
 */
export const DEFAULT_ACCOUNT_VALUE = '__default__';

/** One account the picker can offer: a registered row, keyed by its registry id. */
export interface SelectableAccount extends ClaudeAccountRef {
  /** The registry id the launch hint carries. Never null — see {@link AccountSwitch.accounts}. */
  id: string;
}

/** What {@link useAccountSwitch} hands the status-bar menu. */
export interface AccountSwitch {
  /**
   * The accounts to offer, in the order the operator registered them.
   *
   * REGISTERED rows only. A row with `id: null` describes a root nobody
   * registered (the inherited `$CLAUDE_CONFIG_DIR`, `~/.claude`); a hint can only
   * name an account by id, so offering one would produce a pick the server has to
   * throw away. The unregistered root is reachable as the default option instead.
   *
   * Each carries `isAccountRoot`, so the menu can mark an account the server
   * cannot find rather than offering it as if it were ready.
   */
  accounts: SelectableAccount[];
  /** The radio value currently selected: an account id, or the default sentinel. */
  selectedValue: string;
  /** Whether a switcher is worth showing at all (more than one account registered). */
  isMultiAccount: boolean;
  /**
   * What the default option names — the account the server would pick for a new
   * session — or `undefined` before the config lands. Read by the picker as
   * "Default — <label>" so choosing nothing is still a legible choice.
   */
  defaultLabel: string | undefined;
  /** Hold an account (or the sentinel) as this session's launch hint. */
  choose: (value: string) => void;
}

/**
 * Read the registered Claude accounts and hold which one THIS session launches on.
 *
 * Writes nothing: the pick is client-held state, spent by the first send. There
 * is therefore no refusal to report — the write that could be refused
 * (`runtimes.claudeCode.defaultAccount`, `operator-only`) now happens only in
 * Settings, where an inline error has room to explain itself.
 */
export function useAccountSwitch(): AccountSwitch {
  const { accounts, resolvedAccount, isMultiAccount } = useClaudeAccounts();
  const pendingAccount = useAppStore((s) => s.pendingAccount);
  const setPendingAccount = useAppStore((s) => s.setPendingAccount);

  const selectable = accounts.filter((account): account is SelectableAccount =>
    Boolean(account.id)
  );

  return {
    accounts: selectable,
    // A hint naming an account that has since been unregistered would leave the
    // group with no matching item and nothing looking selected, so it reads as
    // the default — which is also what the server would do with it.
    selectedValue:
      pendingAccount && selectable.some((account) => account.id === pendingAccount)
        ? pendingAccount
        : DEFAULT_ACCOUNT_VALUE,
    isMultiAccount,
    defaultLabel: resolvedAccount ? claudeAccountName(resolvedAccount, accounts) : undefined,
    choose: (value: string) => setPendingAccount(value === DEFAULT_ACCOUNT_VALUE ? null : value),
  };
}
