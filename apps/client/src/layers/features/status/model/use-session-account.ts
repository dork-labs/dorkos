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
import { useAccountIdentityGate } from '@/layers/entities/runtime';
import { useSessions, useSessionStreamStatus } from '@/layers/entities/session';
import { chipState, type ChipState, type SessionLimitView } from '@/layers/shared/lib';
import { useAccountUsage, useClaudeAccounts } from '@/layers/shared/model';
import { DEFAULT_ACCOUNT_VALUE, useAccountSwitch } from './use-account-switch';
import { useResolvedSessionRuntime } from './use-runtime-chip';

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
 * Which account a session spends and how that account is doing.
 *
 * Reads only data already on the client: the session row (its `accountId`,
 * `account` path, `status` and `trackerItem`), the session stream's live
 * status (its `limit` and `lifecycle` win over the row's, which is only as
 * fresh as the last list read), and the account usage the session list seeds.
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
    accountId = row?.accountId ?? null;
    path = row?.account ?? null;
  }

  // Asked about the account only while the gate is open, so a one-account chat
  // never makes a usage request (spec §12, gate row). The cache is still read.
  const usageView = useAccountUsage(runtime, visible ? { accountId, path } : {});
  const usage =
    (accountId !== null ? usageView.byId.get(accountId) : undefined) ??
    (path !== null ? usageView.byPath.get(path) : undefined) ??
    null;

  const registered =
    (accountId !== null ? accounts.find((account) => account.id === accountId) : undefined) ??
    (path !== null ? accounts.find((account) => account.path === path) : undefined);
  const knownPath = path ?? registered?.path ?? usage?.path ?? null;
  const name = knownPath ? nameFor(knownPath) : (usage?.label ?? accountId);
  const color =
    (accountId !== null ? colorFor(accountId) : null) ??
    (knownPath ? colorFor(knownPath) : null) ??
    usage?.color ??
    null;

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
