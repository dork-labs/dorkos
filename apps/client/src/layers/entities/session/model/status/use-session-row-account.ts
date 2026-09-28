/**
 * Which account a sidebar row's session spends and whether it ran out (spec
 * `claude-account-ui` §6.2).
 *
 * An entity may not import `features/status`, so the row reaches the same
 * answer `useSessionAccount` gives the chip from its own `Session` fields,
 * through the same pure helper (`accountIdentity`) and the same live-status
 * rule, so the dot and the chip agree by construction (§6.4).
 *
 * @module entities/session/model/status/use-session-row-account
 */
import type { Session } from '@dorkos/shared/types';
import type { SessionLifecycle, SessionLimit } from '@dorkos/shared/session-stream';
import { useAccountIdentityGate } from '@/layers/entities/runtime';
import { accountIdentity } from '@/layers/shared/lib';
import { useAccountUsageRecord, useClaudeAccounts } from '@/layers/shared/model';
import { sessionLimitDisplay, type SessionLimitDisplay } from '../../lib/session-limit-text';
import { useSessionStreamStatus } from '../stream/session-stream-store';

/** What a sidebar row shows of its session's account. */
export interface SessionRowAccount {
  /** Whether the account identity gate is open; nothing below is shown while it is false. */
  visible: boolean;
  /** The account's name, or `null` when it cannot be named. */
  name: string | null;
  /** The account's color, `#rrggbb`, or `null` when unknown. */
  color: string | null;
  /**
   * The session's live lifecycle and usage limit, for the `limited` border, or
   * `null` while the gate is closed (so the border never shows it either).
   */
  limitStatus: { lifecycle: SessionLifecycle; limit: SessionLimit | null } | null;
  /** The out-of-usage text and tint the row shows, or `null` for none. */
  limitDisplay: SessionLimitDisplay | null;
}

/**
 * The account a sidebar row names with its dot, and the out-of-usage state it
 * shows, both behind the one account identity gate (`useAccountIdentityGate`).
 *
 * The live status wins over the row's: once the session stream has a status,
 * its `limit` (even `null`, a limit that cleared) is the answer; before that,
 * the list's `status` is (absent reads as no limit). Reads only this row's
 * account's usage from what the session list seeded, and never fetches.
 *
 * @param session - The row's session.
 */
export function useSessionRowAccount(session: Session): SessionRowAccount {
  const visible = useAccountIdentityGate(session.runtime);
  const { accounts, nameFor, colorFor } = useClaudeAccounts();
  const streamStatus = useSessionStreamStatus(session.id);
  const accountId = session.accountId ?? null;
  const path = session.account ?? null;
  // This row's own account's reading only, from what the list seeded: another
  // account's usage event re-renders no row, and nothing is fetched.
  const usage = useAccountUsageRecord(visible ? session.runtime : null, { accountId, path });
  const { name, color } = accountIdentity({ accountId, path, accounts, usage, nameFor, colorFor });

  if (!visible) {
    return { visible, name, color, limitStatus: null, limitDisplay: null };
  }
  const limit = streamStatus ? streamStatus.limit : (session.status?.limit ?? null);
  const lifecycle = streamStatus?.lifecycle ?? session.status?.lifecycle ?? 'idle';
  return {
    visible,
    name,
    color,
    limitStatus: { lifecycle, limit },
    limitDisplay: sessionLimitDisplay(limit),
  };
}
