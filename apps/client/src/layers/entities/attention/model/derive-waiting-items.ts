/**
 * Every raw item waiting on a person — one entry per approval, per ask, per
 * schedule. Pure, the item-granular sibling of {@link deriveAttentionSignals}.
 *
 * `deriveAttentionSignals` answers "what needs the operator" at SESSION
 * granularity: a burst of three asks from one agent collapses to the oldest
 * one, because the Heads Up zone and the arrival watch behind the knock and
 * the OS banner draw one row per blocked session. The Inbox popover draws one
 * CARD per ask (`AskList` groups a burst visually but still counts and
 * answers each one), so it needs the un-collapsed list — this is that list
 * (spec `schedule-approval-experience` §C4).
 *
 * The two derivations differ in granularity on purpose; they must not differ
 * in VOCABULARY. Both build every id and kind through `signal-ids.ts`'s
 * functions, so a change to how one interaction type is classified reaches
 * both at once — the fix for the drift risk the spec names: "a new kind added
 * to one, filtered from the other."
 *
 * @module entities/attention/model/derive-waiting-items
 */
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { Task } from '@dorkos/shared/types';
import type { AttentionSignalKind } from './attention-signal';
import {
  approvalSignalId,
  interactionSignalId,
  interactionSignalKind,
  scheduleSignalId,
} from './signal-ids';

/**
 * One raw item occupying a slot in the waiting queue.
 *
 * Carries only what a count and an agreement check need — no presentation.
 * `id` matches the `AttentionSignal.id` {@link deriveAttentionSignals} would
 * build for the same underlying approval, ask or schedule, so the two lists
 * can be compared directly.
 */
export interface WaitingItem {
  /** Stable across polls — the same namespacing `AttentionSignal.id` uses. */
  id: string;
  /**
   * Always one of the three kinds a raw queue item can be. Never `error`: an
   * errored session raises no approval, no ask and no schedule, so it never
   * reaches this derivation at all — membership is enforced by which sources
   * are read, the same way {@link deriveAttentionSignals}'s own doc describes
   * its BC-5 allowlist.
   */
  kind: Exclude<AttentionSignalKind, 'error'>;
}

/** What {@link deriveWaitingItems} reads: the three raw queues, at full per-item granularity. */
export interface WaitingQueueSources {
  /** Capability approvals waiting on a person. */
  approvals: readonly PendingApproval[];
  /** Every prompt anywhere in the fleet that is waiting on a person, uncollapsed. */
  asks: readonly InteractionPendingEvent[];
  /** Schedules an agent proposed and parked. */
  schedules: readonly Task[];
}

/**
 * Every raw item waiting on a person, in the order the three sources are read.
 *
 * @param sources - The three raw queues.
 */
export function deriveWaitingItems(sources: WaitingQueueSources): WaitingItem[] {
  const items: WaitingItem[] = [];

  for (const approval of sources.approvals) {
    items.push({ id: approvalSignalId(approval.approvalId), kind: 'permission-prompt' });
  }

  for (const ask of sources.asks) {
    items.push({
      id: interactionSignalId(ask.interaction.id),
      kind: interactionSignalKind(ask.interaction.type),
    });
  }

  for (const task of sources.schedules) {
    items.push({ id: scheduleSignalId(task.id), kind: 'schedule-approval' });
  }

  return items;
}
