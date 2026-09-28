/**
 * The usage the status line shows for a session (spec `claude-account-ui`
 * §6.8): its account's reading from the moment it opens, or the turn's own
 * usage when a live frame is newer.
 *
 * @module features/status/model/use-status-usage
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { UsageStatus } from '@dorkos/shared/types';
import { useSessionUsageArrivedAt } from '@/layers/entities/session';
import { useNow } from '@/layers/shared/model';
import {
  accountUsageToStatus,
  newestObservedAt,
  pickUsage,
  readableWindows,
  type UsageSource,
} from '../lib/account-usage-status';
import type { SessionAccount } from './use-session-account';

/** What {@link useStatusUsage} reports. */
export interface StatusUsage {
  /** The usage the item draws, or `null` when there is no reading. */
  usage: UsageStatus | null;
  /** Where {@link usage} came from, or `null` when there is none. */
  source: UsageSource | null;
  /** When {@link usage} was observed, ISO-8601, or `null` when that is not known. */
  observedAt: string | null;
  /** The account's reading, for the popover's per-window bars, or `null`. */
  accountUsage: AccountUsage | null;
}

/**
 * Resolve the status line's usage for one session.
 *
 * Every session on one account reads the same account record, so they show the
 * same numbers and move together on one `account_usage` event. The turn's own
 * `status.usage` wins only as a live frame that arrived after the account's
 * newest reading; a snapshot's copy ranks below the account (see `pickUsage`).
 * Re-reads the clock once a minute so a window whose reset passes stops
 * counting without waiting for a server event.
 *
 * @param sessionId - The session, or `''` when there is none.
 * @param account - The session's account, from `useSessionAccount`.
 * @param turnUsage - The session's own usage (`status.usage`), or `null`.
 */
export function useStatusUsage(
  sessionId: string,
  account: SessionAccount,
  turnUsage: UsageStatus | null
): StatusUsage {
  const tick = useNow();
  const liveTurnAt = useSessionUsageArrivedAt(sessionId);
  const now = new Date(tick);
  // Expiry is already read in `useSessionAccount`, once for every surface.
  const accountUsage = account.pending ? null : account.usage;
  const picked = pickUsage({
    liveTurnUsage: turnUsage,
    liveTurnAt,
    accountStatus: accountUsageToStatus(accountUsage, now),
    accountObservedAt: newestObservedAt(readableWindows(accountUsage)),
  });
  return { ...picked, accountUsage };
}
