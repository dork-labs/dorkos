/**
 * The rows under "Needs attention", gathered from the one engine.
 *
 * Three surfaces draw this list — the home surface's triage header, the Pulse
 * panel's teaser, and the right-panel toggle's badge, which has to count
 * exactly what the panel behind it will show. Composing it once is what keeps
 * the three from disagreeing.
 *
 * @module features/dashboard-attention/model/use-attention-rows
 */
import { useMemo } from 'react';
import type { Task } from '@dorkos/shared/types';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import {
  useAttentionSignals,
  useAttentionSignalsLoading,
  usePendingScheduleApprovals,
  type AttentionSignal,
} from '@/layers/entities/attention';
import { useActivityNotifications } from './use-activity-notifications';

/** Shared empty, so a quiet cockpit never mints a fresh array identity. */
const NO_SIGNALS: readonly AttentionSignal[] = [];

/** What {@link useAttentionRows} answers with. */
export interface AttentionRows {
  /**
   * Schedules an agent proposed and parked. Blocking: nothing runs until a
   * person says yes or no.
   */
  schedules: readonly Task[];
  /**
   * Sessions that stopped with an error, straight from `entities/attention`.
   *
   * **Only the `error` kind.** The other blockages the engine raises —
   * permission prompts and questions — already have a card of their own in
   * "Waiting On You" one group above, and the header pill draws them a third
   * time. Repeating them here would be the same fact in two rows of one
   * header, three lines apart.
   */
  errors: readonly AttentionSignal[];
  /** What recently went wrong, from the Inbox. Not blocking anything. */
  activity: readonly NotificationDTO[];
  /**
   * True while ANY of the three sources is still on its first load.
   *
   * All three, deliberately — a surface that draws "All quiet" the moment two
   * of them answer is claiming something it has not checked, and the session
   * listing behind the error rows is the slowest of the three.
   */
  isLoading: boolean;
  /** How many rows all three groups come to — the number the badge shows. */
  total: number;
}

/**
 * Everything the "Needs attention" area of a surface draws, in draw order.
 *
 * Blocking first (a parked schedule, then a wedged session), and what merely
 * happened after it.
 */
export function useAttentionRows(): AttentionRows {
  const { schedules, isLoading: schedulesLoading } = usePendingScheduleApprovals();
  const signals = useAttentionSignals();
  const signalsLoading = useAttentionSignalsLoading();
  const { items: activity, isLoading: activityLoading } = useActivityNotifications();

  const errors = useMemo(() => {
    const wedged = signals.filter((signal) => signal.kind === 'error');
    return wedged.length === 0 ? NO_SIGNALS : wedged;
  }, [signals]);

  return {
    schedules,
    errors,
    activity,
    isLoading: schedulesLoading || signalsLoading || activityLoading,
    total: schedules.length + errors.length + activity.length,
  };
}
