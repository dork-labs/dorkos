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
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { usePendingExtensionApprovals } from '@/layers/entities/extension';
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
   * Installed extensions waiting for a person to turn them on, oldest first
   * (DOR-2517). Counted like every other waiting item, and never a blockage:
   * nothing is stopped while one waits.
   */
  extensionApprovals: readonly PendingExtensionApproval[];
  /**
   * The same four queues, flattened to one id/kind per item — what an
   * agreement check against {@link deriveAttentionSignals} compares against.
   * Its length always equals the four lengths summed; it exists so that
   * arithmetic is expressed once, through the shared derivation, rather than
   * reassembled at every call site.
   */
  items: readonly WaitingItem[];
  /** True when the approval queue could not be read. */
  isError: boolean;
  /** Retry the approval queue read. */
  retry: () => void;
}

/**
 * Everything waiting on the operator that the Inbox popover renders and
 * counts: capability approvals, prompts agents are parked on, schedules an
 * agent proposed and never armed, and installed extensions waiting to be
 * turned on (DOR-2517).
 *
 * Wraps the same three reads `useAttentionSignals` gathers beside it
 * (`usePendingApprovals`, `usePendingInteractions`, `usePendingScheduleApprovals`)
 * plus `usePendingExtensionApprovals`, which Heads up deliberately does not
 * read (an extension waiting is not a blockage), so the popover has one call to
 * make instead of four, and derives `items` through {@link deriveWaitingItems}
 * rather than letting a caller re-sum the lengths by hand.
 */
export function useWaitingQueue(): WaitingQueueState {
  const { approvals, isError, retry } = usePendingApprovals();
  const { interactions: asks } = usePendingInteractions();
  const { schedules } = usePendingScheduleApprovals();
  const { approvals: extensionApprovals } = usePendingExtensionApprovals();

  const items = useMemo(
    () => deriveWaitingItems({ approvals, asks, schedules, extensionApprovals }),
    [approvals, asks, schedules, extensionApprovals]
  );

  return { approvals, asks, schedules, extensionApprovals, items, isError, retry };
}
