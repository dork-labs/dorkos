/**
 * The Inbox popover's one derivation of "what's waiting on you" — the raw
 * objects a card is built from, plus the shared id/kind vocabulary
 * {@link deriveAttentionSignals} names the same blockage with.
 *
 * Before this, the popover (`widgets/inbox-bell`) called
 * `usePendingApprovals`/`usePendingInteractions`/`usePendingScheduleApprovals`
 * directly and summed their lengths inline, with no dedicated derivation of
 * its own — the sound/banner machinery's `useAttentionSignals` was the only
 * named answer to "what's blocking" in the entity. This hook is the popover's
 * named answer, so an entity-layer change to what counts as a blockage has
 * exactly one derivation to update on the read side and one here (spec
 * `schedule-approval-experience` §C4).
 *
 * @module entities/attention/model/use-waiting-queue
 */
import { useCallback, useMemo } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { Task } from '@dorkos/shared/types';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import type {
  ExtensionDecisionDTO,
  PendingDecisionOffer,
} from '@dorkos/shared/extension-decision-schemas';
import {
  extensionDecisionsKey,
  extensionQueryKeys,
  useExtensionDecisions,
  usePendingExtensionApprovals,
} from '@/layers/entities/extension';
import { TASKS_KEY } from '@/layers/entities/tasks';
import { deriveWaitingItems, type WaitingItem } from './derive-waiting-items';
import { PENDING_APPROVALS_QUERY_KEY, usePendingApprovals } from './use-pending-approvals';
import { PENDING_INTERACTIONS_QUERY_KEY, usePendingInteractions } from './use-pending-interactions';
import { usePendingScheduleApprovals } from './use-pending-schedule-approvals';

/** What {@link useWaitingQueue} hands its consumer. */
export interface WaitingQueueState {
  /**
   * Capability approvals waiting on a person, oldest first.
   *
   * Mutable, matching {@link usePendingApprovals}'s own return type — a
   * `readonly` array here would reject `ApprovalList`'s existing prop type
   * without any actual mutation ever happening.
   */
  approvals: PendingApproval[];
  /** Every prompt anywhere in the fleet that is waiting on a person. */
  asks: readonly InteractionPendingEvent[];
  /** Schedules an agent proposed and parked, oldest first. */
  schedules: readonly Task[];
  /**
   * Installed extensions waiting for a person to turn them on, oldest first
   * (DOR-2517). Counted like every other waiting item, and never a blockage:
   * nothing is stopped while one waits.
   */
  extensionApprovals: readonly PendingExtensionApproval[];
  /**
   * Decisions extensions asked a person about, oldest first (spec
   * `flow-multiproject` §7.5): of running extensions, in folders that exist.
   */
  extensionDecisions: readonly ExtensionDecisionDTO[];
  /**
   * One-time "next time, on its own?" offers a person has not answered yet.
   * Not waiting items: they are drawn under the answered row in Activity.
   */
  decisionOffers: readonly PendingDecisionOffer[];
  /**
   * The same four queues, flattened to one id/kind per item — what an
   * agreement check against {@link deriveAttentionSignals} compares against.
   * Its length always equals the four lengths summed; it exists so that
   * arithmetic is expressed once, through the shared derivation, rather than
   * reassembled at every call site.
   */
  items: readonly WaitingItem[];
  /**
   * True while any of the five reads is still on its first load.
   *
   * Every read, deliberately: a surface that says "Nothing needs you" the
   * moment four of them answer is claiming something it has not checked.
   */
  isLoading: boolean;
  /**
   * True when the approval queue could not be read. Drives the bell's
   * "couldn't check approvals" card and its retry, which are about that queue.
   */
  isError: boolean;
  /**
   * True when ANY of the five reads failed. A failed read answers with an
   * empty list, and an empty list is not "nothing waiting": a surface that
   * says all is quiet must not say it while this is true.
   */
  isAnyError: boolean;
  /** Read again every one of the five queues whose last read failed. */
  retryFailed: () => void;
  /** Retry the approval queue read. */
  retry: () => void;
}

/** The five reads the queue is built from, by query key. */
function waitingQueryKeys(): readonly QueryKey[] {
  return [
    PENDING_APPROVALS_QUERY_KEY,
    PENDING_INTERACTIONS_QUERY_KEY,
    TASKS_KEY,
    extensionQueryKeys.pendingApprovals(),
    extensionDecisionsKey(),
  ];
}

/**
 * Everything waiting on the operator: capability approvals, prompts agents are
 * parked on, schedules an agent proposed and never armed, installed extensions
 * waiting to be turned on (DOR-2517), and decisions extensions asked about.
 *
 * **The one answer to "is anything waiting on me?"** The Inbox popover renders
 * and counts it, and the Pulse panel reads the same `items` before it may say
 * "Nothing needs you" — so the two cannot disagree about whether something is
 * waiting (DOR-2578). A new kind added here reaches both at once.
 *
 * Wraps the same three reads `useAttentionSignals` gathers beside it
 * (`usePendingApprovals`, `usePendingInteractions`, `usePendingScheduleApprovals`)
 * plus `usePendingExtensionApprovals`, which Heads up deliberately does not
 * read (an extension waiting is not a blockage), so the popover has one call to
 * make instead of four, and derives `items` through {@link deriveWaitingItems}
 * rather than letting a caller re-sum the lengths by hand.
 */
export function useWaitingQueue(): WaitingQueueState {
  const queryClient = useQueryClient();
  const { approvals, isLoading: approvalsLoading, isError, retry } = usePendingApprovals();
  const {
    interactions: asks,
    isLoading: asksLoading,
    isError: asksError,
  } = usePendingInteractions();
  const {
    schedules,
    isLoading: schedulesLoading,
    isError: schedulesError,
  } = usePendingScheduleApprovals();
  const {
    approvals: extensionApprovals,
    isLoading: extensionApprovalsLoading,
    isError: extensionApprovalsError,
  } = usePendingExtensionApprovals();
  const {
    decisions: extensionDecisions,
    offers: decisionOffers,
    isLoading: decisionsLoading,
    isError: decisionsError,
  } = useExtensionDecisions();

  // Only the reads that failed, and only enabled ones: a disabled query (Tasks
  // switched off) is never refetched by `refetchQueries`.
  const retryFailed = useCallback(() => {
    for (const queryKey of waitingQueryKeys()) {
      void queryClient.refetchQueries({
        queryKey,
        // Exact: `['tasks']` is a prefix of other task reads (a run list, say)
        // that are not part of this queue.
        exact: true,
        predicate: (query) => query.state.status === 'error',
      });
    }
  }, [queryClient]);

  const items = useMemo(
    () =>
      deriveWaitingItems({ approvals, asks, schedules, extensionApprovals, extensionDecisions }),
    [approvals, asks, schedules, extensionApprovals, extensionDecisions]
  );

  return {
    approvals,
    asks,
    schedules,
    extensionApprovals,
    extensionDecisions,
    decisionOffers,
    items,
    isLoading:
      approvalsLoading ||
      asksLoading ||
      schedulesLoading ||
      extensionApprovalsLoading ||
      decisionsLoading,
    isError,
    isAnyError: isError || asksError || schedulesError || extensionApprovalsError || decisionsError,
    retryFailed,
    retry,
  };
}
