import { useQuery } from '@tanstack/react-query';
import { CREDITS_ACCOUNT_ID, IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { ServerConfig } from '@dorkos/shared/types';
import {
  claudeAccountName,
  CREDITS_ACCOUNT_COLOR,
  CREDITS_ACCOUNT_LABEL,
  type ClaudeAccountRef,
} from '../../lib/claude-accounts';
import { useTransport } from '../TransportContext';
import { useAccountUsageRecord } from './use-account-usage';
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
  /**
   * True once the config has landed, so an answer read from this view (no
   * accounts, one account) is the real one rather than the empty start.
   */
  isLoaded: boolean;
  /**
   * The shortest honest name for an account path: a registered account's label,
   * the host's label for the standalone default ("Main (this computer's
   * sign-in)"), else the folder name. Every surface that names a Claude account
   * by its path reads this, so the default reads the same everywhere.
   */
  nameFor: (path: string) => string;
  /**
   * The color the operator STORED for the standalone default account
   * (`runtimes.claudeCode.defaultAccountColor`), or `null` when it shows the
   * default for its position. Ignored while a registered account has the
   * default folder: that account's own color wins.
   */
  defaultAccountColor: string | null;
  /**
   * The color the default account is drawn in, as the server resolved it, or
   * `null` when the server did not say. Display this; bind a color picker to
   * {@link defaultAccountColor}.
   */
  defaultAccountResolvedColor: string | null;
  /**
   * The color of an account: a registered one found by registry id and then by
   * path, or `default`, drawn in the color the server resolved for it. `null`
   * when nothing matches.
   */
  colorFor: (pathOrId: string) => string | null;
  /**
   * The person's OWN default sign-in, as the server resolved it: where new
   * work goes once credits are turned off. Equal to {@link resolvedAccount}
   * except while credits are the default.
   */
  ownResolvedAccount: string | undefined;
  /**
   * The DorkOS credits entry as the server describes it, or `null` on a server
   * too old to offer it (ADR 261001-000811). Never a registry row.
   */
  credits: NonNullable<NonNullable<ServerConfig['claudeCode']>['credits']> | null;
  /**
   * The credits entry shaped like an account, for a picker that offers it
   * beside the registered ones: present while credits can be chosen, or while
   * they are already the default (so the picker never renders blank). `null`
   * otherwise.
   */
  creditsEntry: ClaudeAccountEntry | null;
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

  const { data, isSuccess } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

  const claudeCode = data?.claudeCode;
  const accounts: ClaudeAccountEntry[] = claudeCode?.accounts ?? [];
  // The standalone default's reading carries the host's label for it
  // (decision §12). Read from the cache the session list and Settings seed,
  // subscribed to that one record so other accounts' updates re-render nothing,
  // and never fetched here.
  const defaultReading = useAccountUsageRecord('claude-code', {
    accountId: IMPLICIT_ACCOUNT_ID,
    path: null,
  });
  const standaloneDefault =
    defaultReading && !accounts.some((account) => account.path === defaultReading.path)
      ? { path: defaultReading.path, label: defaultReading.label }
      : null;

  const credits = claudeCode?.credits ?? null;
  const creditsEntry: ClaudeAccountEntry | null =
    credits && (credits.available || credits.isDefault)
      ? {
          id: CREDITS_ACCOUNT_ID,
          path: credits.path,
          label: CREDITS_ACCOUNT_LABEL,
          color: CREDITS_ACCOUNT_COLOR,
          colorIsDefault: false,
          isAccountRoot: true,
        }
      : null;

  return {
    accounts,
    // Where a new session really runs: the credits folder while credits are the
    // machine default, which the server's `resolvedAccount` (the person's own
    // default sign-in, kept for when credits are turned off) does not say.
    resolvedAccount: credits?.isDefault ? credits.path : claudeCode?.resolvedAccount,
    inherited: credits?.isDefault ? false : (claudeCode?.inherited ?? true),
    // Credits are a second place work can run even beside this computer's one
    // sign-in, so offering them makes the choice worth showing.
    isMultiAccount: accounts.length > 1 || creditsEntry !== null,
    ownResolvedAccount: claudeCode?.resolvedAccount,
    credits,
    creditsEntry,
    isLoaded: isSuccess,
    defaultAccountColor: claudeCode?.defaultAccountColor ?? null,
    defaultAccountResolvedColor: claudeCode?.defaultAccountResolvedColor ?? null,
    nameFor: (path: string) =>
      credits && path === credits.path
        ? CREDITS_ACCOUNT_LABEL
        : claudeAccountName(path, accounts, standaloneDefault),
    colorFor: (pathOrId: string) => {
      if (pathOrId === CREDITS_ACCOUNT_ID || (credits && pathOrId === credits.path)) {
        return CREDITS_ACCOUNT_COLOR;
      }
      const registered =
        accounts.find((account) => account.id === pathOrId) ??
        accounts.find((account) => account.path === pathOrId);
      if (registered) return registered.color;
      // The default account's color is the server's decision
      // (`defaultAccountResolvedColor`), never re-derived here: which row it
      // aliases turns on real paths and a default folder the client cannot see.
      if (pathOrId !== IMPLICIT_ACCOUNT_ID) return null;
      return claudeCode?.defaultAccountResolvedColor ?? null;
    },
  };
}
