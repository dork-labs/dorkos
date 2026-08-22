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
import { useMemo } from 'react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { Task } from '@dorkos/shared/types';
import { deriveWaitingItems, type WaitingItem } from './derive-waiting-items';
import { usePendingApprovals } from './use-pending-approvals';
import { usePendingInteractions } from './use-pending-interactions';
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
   * The same three queues, flattened to one id/kind per item — what an
   * agreement check against {@link deriveAttentionSignals} compares against.
   * Its length always equals `approvals.length + asks.length + schedules.length`;
   * it exists so that arithmetic is expressed once, through the shared
   * derivation, rather than reassembled at every call site.
   */
  items: readonly WaitingItem[];
  /** True when the approval queue could not be read. */
  isError: boolean;
  /** Retry the approval queue read. */
  retry: () => void;
}

/**
 * Everything waiting on the operator that the Inbox popover renders and
 * counts: capability approvals, prompts agents are parked on, and schedules
 * an agent proposed and never armed.
 *
 * Wraps the same three reads `useAttentionSignals` gathers beside it
 * (`usePendingApprovals`, `usePendingInteractions`, `usePendingScheduleApprovals`)
 * so the popover has one call to make instead of three, and derives `items`
 * through {@link deriveWaitingItems} rather than letting a caller re-sum the
 * three lengths by hand.
 */
export function useWaitingQueue(): WaitingQueueState {
  const { approvals, isError, retry } = usePendingApprovals();
  const { interactions: asks } = usePendingInteractions();
  const { schedules } = usePendingScheduleApprovals();

  const items = useMemo(
    () => deriveWaitingItems({ approvals, asks, schedules }),
    [approvals, asks, schedules]
  );

  return { approvals, asks, schedules, items, isError, retry };
}
