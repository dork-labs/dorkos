/**
 * The queue of approvals waiting on a person — unchanged behaviour, moved down
 * a layer.
 *
 * It lived in `features/approvals` until the sidebar needed the same queue, and
 * a feature may not read a sibling feature's model. `features/approvals`
 * re-exports it, so every surface that already imported it kept its one import.
 *
 * @module entities/attention/model/use-pending-approvals
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  PendingApprovalSchema,
  type PendingApproval,
  type PendingApprovalsResponse,
} from '@dorkos/shared/approval-schemas';
import { useEventSubscription, useTransport } from '@/layers/shared/model';

/** Query key for the pending-approval list. */
export const PENDING_APPROVALS_QUERY_KEY = ['approvals', 'pending'] as const;

/**
 * Grace added to an expiry timer so it fires strictly after the deadline.
 *
 * The server treats the boundary itself as still live (`now > expiresAt`), so a
 * timer landing exactly on it would find nothing to remove and reschedule.
 */
const EXPIRY_SLACK_MS = 500;

/**
 * Longest delay `setTimeout` actually honors: 2^31 - 1 ms, about 24.8 days.
 *
 * Anything larger is silently clamped to 1ms by the platform rather than
 * rejected, so a timer aimed further out fires immediately — which, combined
 * with the early-fire re-arm below, would spin. Nothing a correct server writes
 * gets near this (`APPROVAL_TTL_MS` is two hours), but `expiresAt` is an
 * unbounded string on the wire and a client clock weeks BEHIND the server lands
 * here directly: a VM restored from an old snapshot, a dead CMOS battery, a
 * container with a bad clock.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** What {@link usePendingApprovals} hands its consumers. */
export interface PendingApprovalsState {
  /** Approvals waiting on a person, oldest first. */
  approvals: PendingApproval[];
  /** True only on the very first load, before any answer has arrived. */
  isLoading: boolean;
  /**
   * True when the list could not be read.
   *
   * This is NOT the same as "nothing is waiting", and the difference matters: an
   * agent blocked on an approval it can never get would otherwise show a person a
   * completely empty dashboard.
   */
  isError: boolean;
  /** Retry the list read. */
  retry: () => void;
}

/**
 * Whether an approval's decision window is still open.
 *
 * @param approval - The approval to check.
 * @param now - The current time in epoch milliseconds.
 */
function isLive(approval: PendingApproval, now: number): boolean {
  const expiresAt = Date.parse(approval.expiresAt);
  // An unparseable expiry is left alone rather than silently discarded — dropping
  // a real request because of a formatting bug is the worse failure.
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt > now;
}

/**
 * Drop every approval whose window has closed from the cached list.
 *
 * Returns the cache reference untouched when nothing expired, so this can never
 * loop with the effect that schedules it.
 *
 * @param queryClient - The query client holding the cached list.
 * @returns True when at least one approval was removed.
 */
function pruneExpired(queryClient: QueryClient): boolean {
  let removed = false;
  queryClient.setQueryData<PendingApprovalsResponse>(PENDING_APPROVALS_QUERY_KEY, (current) => {
    if (!current) return current;
    const live = current.approvals.filter((a) => isLive(a, Date.now()));
    if (live.length === current.approvals.length) return current;
    removed = true;
    return { approvals: live };
  });
  return removed;
}

/**
 * Approvals waiting on a person, kept live.
 *
 * The list is fetched on mount and then kept in step by the global event stream:
 * `approval_pending` adds a card the moment an agent asks, and
 * `approval_resolved` retires one as soon as anybody decides — including from
 * another window. The `/api/events` stream has no replay, so the fetch is what
 * makes a freshly opened cockpit correct and the events are what keep it that way.
 *
 * Expiry is the one ending the server never announces by itself: it is enforced
 * when a token is presented, so an approval nobody answered and no agent retried
 * produces no event at all. This hook therefore retires its own cards on a timer
 * aimed at the soonest deadline in the list. The rule is the same one the server
 * applies in `listPending`, so pruning locally cannot disagree with a later read,
 * and it keeps working while the connection is down — exactly when a dead card
 * would otherwise sit there looking answerable.
 */
export function usePendingApprovals(): PendingApprovalsState {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: PENDING_APPROVALS_QUERY_KEY,
    queryFn: () => transport.listPendingApprovals(),
  });

  useEventSubscription('approval_pending', (raw) => {
    const parsed = PendingApprovalSchema.safeParse(raw);
    if (!parsed.success) return;
    queryClient.setQueryData<PendingApprovalsResponse>(PENDING_APPROVALS_QUERY_KEY, (current) => {
      const approvals = current?.approvals ?? [];
      // The same approval can arrive twice if a refetch races the event.
      if (approvals.some((a) => a.approvalId === parsed.data.approvalId)) return current;
      return { approvals: [...approvals, parsed.data] };
    });
  });

  useEventSubscription('approval_resolved', () => {
    // Every terminal outcome (granted, denied, spent, expired) removes a card, and
    // the server is the authority on what is still pending — so re-read rather
    // than replay the transition locally.
    void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
  });

  const cached = data?.approvals;
  // Bumped only when a fired timer removed nothing, to re-arm the effect. See the
  // effect below for why that case exists and why bumping cannot spin.
  const [rearm, setRearm] = useState(0);

  // One timer, aimed at the soonest deadline in the list. Pruning rewrites the
  // cache, which re-runs this effect over a shorter list and re-aims at the next
  // deadline — so a queue retires one card at a time with no polling.
  useEffect(() => {
    if (!cached || cached.length === 0) return;
    const deadlines = cached.map((a) => Date.parse(a.expiresAt)).filter((ms) => !Number.isNaN(ms));
    if (deadlines.length === 0) return;
    const delay = Math.min(...deadlines) + EXPIRY_SLACK_MS - Date.now();
    if (delay <= 0) {
      // Already past the soonest deadline, so this prune always removes the row
      // that produced it — the cache reference changes and the effect re-runs on
      // its own. Deliberately does NOT touch `rearm`: bumping on a synchronous
      // path that can repeat with the same inputs is exactly how this would spin.
      pruneExpired(queryClient);
      return;
    }
    // A deadline past what `setTimeout` can express needs no timer at all: no tab
    // lives 25 days, and the mount-time read plus refetch-on-focus already
    // correct the list. Arming one would be worse than useless — the platform
    // clamps it to 1ms, it fires against a live row, prunes nothing, and the
    // re-arm below sends it round again every millisecond.
    if (delay > MAX_TIMEOUT_MS) return;
    const timer = setTimeout(() => {
      // A timer that fires EARLY (the clock stepped backwards, e.g. an NTP
      // correction) finds every approval still live, so the prune is a no-op and
      // leaves the cache reference identical — the same property that stops this
      // effect looping also stops it re-running, and with no re-run no timer is
      // armed and expiry dies for the whole queue. Re-arm explicitly. Safe from
      // spinning because the guard above refuses the one case where a positive
      // delay does NOT mean real time passes before this runs.
      if (!pruneExpired(queryClient)) setRearm((n) => n + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [cached, queryClient, rearm]);

  return {
    approvals: cached ?? [],
    isLoading,
    isError,
    retry: () => void refetch(),
  };
}
