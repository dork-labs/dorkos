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
import { useEffect } from 'react';
import { claudeAccountName, type ClaudeAccountRef } from '@/layers/shared/lib';
import { useAppStore, useClaudeAccounts } from '@/layers/shared/model';
import { useCurrentAgent } from '@/layers/entities/agent';

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
   * What picking nothing would actually bill — the account the LADDER resolves
   * for this session, not merely the server default. `undefined` when this
   * surface cannot yet tell, and the row then reads a bare "Default" rather than
   * a name that might be wrong. See {@link useAccountSwitch}.
   */
  defaultLabel: string | undefined;
  /** Hold an account (or the sentinel) as this session's launch hint. */
  choose: (value: string) => void;
}

/**
 * Read the registered Claude accounts and hold which one THIS session launches on.
 *
 * Writes no config: the pick is client-held state, spent by the first send. There
 * is therefore no refusal to report — the write that could be refused
 * (`runtimes.claudeCode.defaultAccount`, `operator-only`) now happens only in
 * Settings, where an inline error has room to explain itself.
 *
 * **The default row names the ladder's answer, not the server's default.** The
 * ladder is agent-then-default (`launch-resolver.ts`), so on a directory whose
 * agent is pinned to Acme Corp, a machine whose default is Personal would still
 * bill Acme — and a row reading "Default — Personal" would be a false statement
 * about money. The agent is read at the working directory the launch resolves
 * against (`useCurrentAgent`, the same per-path manifest query the agent surfaces
 * use), and an agent account id that is no longer registered falls back to the
 * server default exactly as the server's own tier-2 fallthrough does. Until that
 * read settles the label is `undefined` — silence beats a confident wrong name.
 */
export function useAccountSwitch(): AccountSwitch {
  const { accounts, resolvedAccount, isMultiAccount } = useClaudeAccounts();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const pendingAccount = useAppStore((s) => s.pendingAccount);
  const setPendingAccount = useAppStore((s) => s.setPendingAccount);
  // The agent the launch would resolve against — same directory, same query the
  // agent surfaces read, so this cannot disagree with the profile.
  const agentQuery = useCurrentAgent(selectedCwd);

  const selectable = accounts.filter((account): account is SelectableAccount =>
    Boolean(account.id)
  );
  const isRegistered = (id: string) => selectable.some((account) => account.id === id);

  // An account can be unregistered from Settings while this menu is mounted and
  // holding a pick of it. Masking the RADIO back to Default is not enough — the
  // send path reads the store, so the dead id would still ride the first message
  // (the server would warn and fall through, but the cockpit would have lied
  // about which account it asked for). Drop it instead, so display and wire say
  // the same thing.
  //
  // Guarded on knowing of ANY registered account: an empty list is what a config
  // read that has not landed looks like, and clearing on that would delete a
  // legitimate pick every time the query refetched.
  const staleHint =
    pendingAccount !== null && selectable.length > 0 && !isRegistered(pendingAccount);
  useEffect(() => {
    if (staleHint) setPendingAccount(null);
  }, [staleHint, setPendingAccount]);

  return {
    accounts: selectable,
    selectedValue:
      pendingAccount && isRegistered(pendingAccount) ? pendingAccount : DEFAULT_ACCOUNT_VALUE,
    isMultiAccount,
    defaultLabel: resolveDefaultLabel({
      accounts,
      resolvedAccount,
      selectable,
      // With no working directory there is no agent to pin anything, so the
      // server default IS the ladder's answer and can be named right away. With
      // one, the manifest read has to have landed first — the query is disabled
      // without a path, so its pending state would otherwise never resolve and
      // the row would read a bare "Default" forever.
      agentAccountId: selectedCwd ? agentQuery.data?.account : undefined,
      agentKnown: !selectedCwd || agentQuery.isSuccess,
    }),
    choose: (value: string) => setPendingAccount(value === DEFAULT_ACCOUNT_VALUE ? null : value),
  };
}

/**
 * The name for "pick nothing" — what the server's ladder would bill.
 *
 * Mirrors `resolveLaunchAccountRoot`'s tier order below the hint: the agent's
 * account when it resolves, else the server default.
 *
 * @param input.accounts - Every account row the server reported, for naming.
 * @param input.resolvedAccount - The server default's absolute path.
 * @param input.selectable - Registered rows, the only ones an id can name.
 * @param input.agentAccountId - The agent's pinned account id, if it has one.
 * @param input.agentKnown - Whether the agent question has actually been answered.
 * @returns A display name, or `undefined` when the answer is not known yet.
 */
function resolveDefaultLabel(input: {
  accounts: readonly ClaudeAccountRef[];
  resolvedAccount: string | undefined;
  selectable: readonly SelectableAccount[];
  agentAccountId: string | undefined;
  agentKnown: boolean;
}): string | undefined {
  const { accounts, resolvedAccount, selectable, agentAccountId, agentKnown } = input;
  if (!agentKnown) return undefined;
  if (agentAccountId !== undefined) {
    const pinned = selectable.find((account) => account.id === agentAccountId);
    // Only when it RESOLVES. An id the operator has since unregistered makes the
    // server fall through to the default, so naming it here would describe a
    // billing that will not happen.
    if (pinned) return claudeAccountName(pinned.path, accounts);
  }
  return resolvedAccount ? claudeAccountName(resolvedAccount, accounts) : undefined;
}
