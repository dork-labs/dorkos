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
 * @param sessionId - The session the pick belongs to. Stored WITH the choice, so
 *   a pick made on one conversation can never be shown or sent on another — the
 *   store is a module global that outlives the menu, and "this session only" has
 *   to be a property of the data rather than of who happens to be mounted.
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
export function useAccountSwitch(sessionId: string): AccountSwitch {
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
  // **Only a POSITIVE read may end a pick: registry present, id absent.** An
  // empty list is not evidence the account is gone — it is equally what a config
  // read still in flight, one that errored, and one the server could not
  // complete all look like. Deleting an operator's billing choice because the
  // machine briefly could not answer would be the same class of bug as the one
  // above, pointing the other way. Hence the `length > 0` term: it is the
  // narrowest available "the registry really is readable" signal, and it stays
  // correct if the wire later grows an explicit unavailable flag — such a
  // response reports no accounts, so this refuses to judge either way.
  // Only this session's own pick is ever in play here.
  const heldId = pendingAccount?.sessionId === sessionId ? pendingAccount.id : null;

  const staleHint = heldId !== null && selectable.length > 0 && !isRegistered(heldId);
  useEffect(() => {
    if (staleHint) setPendingAccount(null);
  }, [staleHint, setPendingAccount]);

  return {
    accounts: selectable,
    selectedValue: heldId && isRegistered(heldId) ? heldId : DEFAULT_ACCOUNT_VALUE,
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
    choose: (value: string) =>
      setPendingAccount(value === DEFAULT_ACCOUNT_VALUE ? null : { id: value, sessionId }),
  };
}

/**
 * The name for "pick nothing" — what the server's ladder would bill.
 *
 * Mirrors `resolveLaunchAccountRoot`'s tier order below the hint: the agent's
 * account when it resolves, else the server default.
 *
 * **Freshness contract.** The agent half is only as current as the cached
 * manifest behind `useCurrentAgent` (`agentKeys.byPath`, 60s stale time), so this
 * label is right exactly as long as every writer of an agent's `account` goes
 * through `useUpdateAgent`, which invalidates that key. The agent profile's
 * Account row does. A future writer that patches an agent by some other route
 * would leave this row naming the previous account until the stale time lapses —
 * wrong about money, and silently so. Route agent writes through `useUpdateAgent`.
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
