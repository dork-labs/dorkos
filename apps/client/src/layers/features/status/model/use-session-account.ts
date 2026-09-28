/**
 * The one place the chip, its popover, the header badge and the out-of-usage
 * banner learn which account a session spends and how that account is doing
 * (spec `claude-account-ui` §6.4). Each of them reads this hook, so they cannot
 * disagree; the sidebar (an entity, which may not import a feature) reaches the
 * same answer from the row's own fields through the same pure helpers.
 *
 * @module features/status/model/use-session-account
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { useAccountIdentityGate, useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { useSessions, useSessionStreamStatus } from '@/layers/entities/session';
import {
  accountIdentity,
  chipState,
  type ChipState,
  type SessionLimitView,
} from '@/layers/shared/lib';
import { useAccountUsage, useClaudeAccounts, useNow } from '@/layers/shared/model';
import { withExpiredWindows } from '../lib/account-usage-status';
import { DEFAULT_ACCOUNT_VALUE, useAccountSwitch } from './use-account-switch';
import { useResolvedSessionRuntime } from './use-runtime-chip';
import type { AccountPromotionState } from './status-bar-registry';

/** The registry id every runtime without an account registry bills (S4 N9). */
const IMPLICIT_ACCOUNT_ID = 'default';

/** Milliseconds of `updatedAt`, with `null` (and anything unreadable) losing to any time. */
function updatedAtMs(usage: AccountUsage): number {
  const ms = usage.updatedAt === null ? Number.NaN : Date.parse(usage.updatedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * The newer of two readings of one account: the shared cache's (seeded from the
 * session list, kept current by `account_usage`) and the one the session's own
 * status carries from open (`status.accountUsage`). The cache wins a tie.
 */
function newerReading(
  cached: AccountUsage | null,
  fromStatus: AccountUsage | null
): AccountUsage | null {
  if (!cached) return fromStatus;
  if (!fromStatus) return cached;
  return updatedAtMs(fromStatus) > updatedAtMs(cached) ? fromStatus : cached;
}

/** The flow work item a session serves, as `Session.trackerItem` carries it. */
export interface SessionTrackerItem {
  /** The item identifier, such as `DOR-2353`. */
  id: string;
  /** The flow run's stage, when it reports one. */
  stage?: string;
  /** The flow run's own status, when it reports one. */
  runStatus?: string;
}

/** What {@link useSessionAccount} knows about a session's account. */
export interface SessionAccount {
  /**
   * Whether account identity may be shown at all: the one gate
   * (`useAccountIdentityGate`), open only with two or more accounts on a
   * runtime that tells them apart. Every identity surface renders nothing
   * while this is false.
   */
  visible: boolean;
  /** The session's runtime, or `null` while it resolves. */
  runtime: string | null;
  /** The account's registry id (`default` for a runtime's implicit account), or `null` when unknown. */
  accountId: string | null;
  /** The account's config directory, or `null` when unknown. */
  path: string | null;
  /** The account's shortest honest name (label, else folder name), or `null` when unknown. */
  name: string | null;
  /** The account's color, `#rrggbb`, or `null` when unknown. */
  color: string | null;
  /** The account's usage, or `null` when no reading is cached. */
  usage: AccountUsage | null;
  /** The session's usage limit, or `null` when it has none. */
  limit: SessionLimitView | null;
  /** How the chip reads the account (see `chipState`). */
  chipState: ChipState;
  /** The flow work item this session serves, or `null`. */
  trackerItem: SessionTrackerItem | null;
  /** The session's lifecycle, or `null` before it has launched. */
  lifecycle: SessionLifecycle | null;
  /**
   * True before the first message: the account is still the pre-launch hint
   * (`pendingAccount`, else what the server's ladder would pick), so the chip
   * is the account picker rather than a readout.
   */
  pending: boolean;
}

/**
 * The account chip's promotion state, or `null` when the chip draws nothing:
 * the identity gate is closed, or a started session's account cannot be named
 * (the chip then renders nothing rather than invent a label). The status line
 * reads this for the `account` item AND for whether it absorbs the usage
 * display (`isUsageAbsorbed`), so a chip that draws nothing never hides usage.
 *
 * @param account - The session's account, from {@link useSessionAccount}.
 */
export function accountChipPromotion(account: SessionAccount): AccountPromotionState | null {
  if (!account.visible) return null;
  if (!account.pending && account.name === null) return null;
  return { chipState: account.chipState };
}

/**
 * Which account a session spends and how that account is doing.
 *
 * Reads only data already on the client: the session row (its `accountId`,
 * `account` path, `status` and `trackerItem`), the session stream's live
 * status (its `limit` and `lifecycle` win over the row's, which is only as
 * fresh as the last list read, and its `accountUsage` stands in until the
 * shared cache has a newer reading), and the account usage the session list
 * seeds. A runtime without accounts resolves to its implicit `default` account.
 * So it normally makes no request of its own: usage is fetched only when the
 * gate is open and the seed lacks this account.
 *
 * Before launch the account is the person's pick for this session, else the
 * account the server's ladder would pick (the agent's, else the default).
 *
 * @param sessionId - The session, or `null` when there is none.
 */
export function useSessionAccount(sessionId: string | null): SessionAccount {
  const id = sessionId ?? '';
  const resolved = useResolvedSessionRuntime(id);
  const runtime = resolved.runtime;
  const visible = useAccountIdentityGate(runtime);
  const { sessions } = useSessions();
  const row = id ? (sessions.find((session) => session.id === id) ?? null) : null;
  const streamStatus = useSessionStreamStatus(id);
  const accountSwitch = useAccountSwitch(id);
  const { accounts, nameFor, colorFor } = useClaudeAccounts();
  // A runtime that does not tell accounts apart bills its one implicit account.
  const supportsAccounts = useCapabilitiesForRuntime(runtime)?.supportsAccounts ?? true;

  // `canSelect` is true exactly until the session has a row, which is the same
  // signal the first send spends the pre-launch hint on.
  const pending = runtime !== null && resolved.canSelect;

  let accountId: string | null;
  let path: string | null;
  if (pending) {
    const picked =
      accountSwitch.selectedValue === DEFAULT_ACCOUNT_VALUE
        ? undefined
        : accountSwitch.accounts.find((account) => account.id === accountSwitch.selectedValue);
    path = picked?.path ?? accountSwitch.defaultPath ?? null;
    accountId =
      picked?.id ?? (path ? (accounts.find((account) => account.path === path)?.id ?? null) : null);
  } else {
    accountId = row?.accountId ?? (supportsAccounts ? null : IMPLICIT_ACCOUNT_ID);
    path = row?.account ?? null;
  }

  // Asked about the account only while the gate is open, so a one-account chat
  // never makes a usage request (spec §12, gate row). The cache is still read.
  const usageView = useAccountUsage(runtime, visible ? { accountId, path } : {});
  const cachedUsage =
    (accountId !== null ? usageView.byId.get(accountId) : undefined) ??
    (path !== null ? usageView.byPath.get(path) : undefined) ??
    null;
  // A session opened cold already carries its account's reading in its own
  // status (spec `claude-account-ui` §6.8), so its numbers show before the list
  // or an `account_usage` event has reached the shared cache. Only for a
  // started session: before launch the account is a hint the status is not
  // about.
  const statusUsage = pending ? null : (streamStatus?.accountUsage ?? null);
  // Expiry is read once, here, on a one-minute clock: a window past its reset
  // reads "reset" on the chip's words and bars, its popover, and the usage
  // item alike, even before the server marks it (spec `claude-account-ui` §6.8).
  const tick = useNow();
  const usage = withExpiredWindows(newerReading(cachedUsage, statusUsage), new Date(tick));

  // The sidebar row names and colors its dot through the same helper, so the
  // two agree by construction (spec §6.4).
  const {
    path: knownPath,
    name,
    color,
  } = accountIdentity({ accountId, path, accounts, usage, nameFor, colorFor });

  // The stream's status is the live one: once a snapshot or event has arrived,
  // its `limit` (even `null`, a limit that cleared) wins over the row's.
  // Before launch there is no limit and no lifecycle to read.
  const limit: SessionLimitView | null = pending
    ? null
    : streamStatus
      ? streamStatus.limit
      : (row?.status?.limit ?? null);
  const lifecycle: SessionLifecycle | null = pending
    ? null
    : (streamStatus?.lifecycle ?? row?.status?.lifecycle ?? (row ? 'idle' : null));

  return {
    visible,
    runtime,
    accountId,
    path: knownPath,
    name,
    color,
    usage,
    limit,
    chipState: chipState(usage, limit),
    trackerItem: row?.trackerItem ?? null,
    lifecycle,
    pending,
  };
}
