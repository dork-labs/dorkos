import { useQuery } from '@tanstack/react-query';
import { IMPLICIT_ACCOUNT_ID, resolveAccountColor } from '@dorkos/shared/account-usage';
import { claudeAccountName, type ClaudeAccountRef } from '../../lib/claude-accounts';
import { useTransport } from '../TransportContext';
import { configKeys, CONFIG_STALE_TIME_MS } from './query-keys';

/** A registered account with the color its dot and badge are drawn in. */
export interface ClaudeAccountEntry extends ClaudeAccountRef {
  /** The account's color as lowercase `#rrggbb`: the stored one, else its position's default. */
  color: string;
  /** True when {@link color} is the position's default rather than a color the operator stored. */
  colorIsDefault: boolean;
}

/** What {@link useClaudeAccounts} reports. */
export interface ClaudeAccountsView {
  /**
   * The accounts the operator registered, in the order they registered them,
   * each carrying the server's `isAccountRoot` verdict. Keep that field: a
   * surface that OFFERS an account the server already flagged unusable has to say
   * so, or selecting it silently points new work at a signed-out config.
   */
  accounts: ClaudeAccountEntry[];
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
  /**
   * The color the operator STORED for the standalone default account
   * (`runtimes.claudeCode.defaultAccountColor`), or `null` when it shows the
   * default for its position. Ignored while a registered account has the
   * default folder: that account's own color wins.
   */
  defaultAccountColor: string | null;
  /**
   * The color of an account: a registered one found by registry id and then by
   * path, or the default account (`default`, or the path a person chose as the
   * default) drawn as the server draws it. `null` when nothing matches.
   */
  colorFor: (pathOrId: string) => string | null;
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
  const accounts: ClaudeAccountEntry[] = claudeCode?.accounts ?? [];
  const defaultAccountColor = claudeCode?.defaultAccountColor ?? null;
  const inherited = claudeCode?.inherited ?? true;

  return {
    accounts,
    resolvedAccount: claudeCode?.resolvedAccount,
    inherited,
    isMultiAccount: accounts.length > 1,
    defaultAccountColor,
    nameFor: (path: string) => claudeAccountName(path, accounts),
    colorFor: (pathOrId: string) => {
      const registered =
        accounts.find((account) => account.id === pathOrId) ??
        accounts.find((account) => account.path === pathOrId);
      if (registered) return registered.color;
      // The default account, colored by the server's rule
      // (`resolveRuntimeAccounts`): an alias row's own color, else the chosen
      // color, else the default for the position after the registered rows.
      // Only a CHOSEN default folder is matched by path: an inherited one may
      // come from the server's environment, which the server's rule ignores.
      const resolved = claudeCode?.resolvedAccount;
      if (pathOrId !== IMPLICIT_ACCOUNT_ID && (inherited || pathOrId !== resolved)) return null;
      const alias = resolved ? accounts.find((account) => account.path === resolved) : undefined;
      return alias?.color ?? resolveAccountColor(defaultAccountColor, accounts.length);
    },
  };
}
