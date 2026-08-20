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
   *
   * **The `Task` objects, so the rows can be drawn — not a second answer to
   * "what needs me".** A parked schedule is an attention signal of its own
   * since DOR-1391, so `total` below counts it out of the one list like
   * everything else; this array exists because an approve/reject card needs the
   * task itself, which a normalized signal deliberately does not carry.
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
   * True while either source is still on its first load.
   *
   * Both, deliberately — a surface that draws "All quiet" the moment one of
   * them answers is claiming something it has not checked. The attention half
   * covers sessions, approvals, prompts and schedules in one answer since
   * DOR-1391, so there is no third flag to compose here any more.
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
 *
 * **Both blocking groups are slices of the ONE list.** Schedules used to be
 * fetched beside the attention engine and counted on afterwards, which meant
 * this hook, the sidebar's Heads up zone and the arrival watch each held their
 * own idea of whether a parked schedule counted. It is an `AttentionSignal`
 * now, so membership and the total are read off `useAttentionSignals` and the
 * task lookup below exists only to hand the view something it can draw.
 */
export function useAttentionRows(): AttentionRows {
  const signals = useAttentionSignals();
  const signalsLoading = useAttentionSignalsLoading();
  const { items: activity, isLoading: activityLoading } = useActivityNotifications();
  // The payload for the cards, not the answer to whether there are any: the
  // ids the one list holds are what decides that, immediately below.
  const { schedules: tasks } = usePendingScheduleApprovals();

  const errors = useMemo(() => {
    const wedged = signals.filter((signal) => signal.kind === 'error');
    return wedged.length === 0 ? NO_SIGNALS : wedged;
  }, [signals]);

  // The tasks the one list is currently calling blocking, in its order. A task
  // whose signal has not landed yet (or has just gone) draws nothing, so the
  // rows on screen and the total below can never disagree.
  const schedules = useMemo(() => {
    const parked = new Set(
      signals
        .filter((signal) => signal.kind === 'schedule-approval')
        .map((signal) => signal.id.slice('schedule:'.length))
    );
    return tasks.filter((task) => parked.has(task.id));
  }, [signals, tasks]);

  return {
    schedules,
    errors,
    activity,
    isLoading: signalsLoading || activityLoading,
    total: schedules.length + errors.length + activity.length,
  };
}
