/**
 * Schedules an agent proposed and parked for a person to decide on.
 *
 * The fourth thing that can need the operator, beside a capability approval, a
 * prompt an agent is parked on, and a session that stopped with an error. An
 * agent creating a schedule through the `tasks_create` MCP tool never arms it
 * — it always parks at `pending_approval` (DOR-504) — and until DOR-1380 gave
 * that a live signal, nothing anywhere said so. This is the read half of
 * saying so.
 *
 * @module entities/attention/model/use-pending-schedule-approvals
 */
import { useMemo } from 'react';
import type { Task } from '@dorkos/shared/types';
import { useTasks, useTasksEnabled } from '@/layers/entities/tasks';

/** Shared empty, so a cockpit with nothing parked never mints a fresh array. */
const NO_SCHEDULES: readonly Task[] = [];

/** What {@link usePendingScheduleApprovals} answers with. */
export interface PendingScheduleApprovals {
  /** Schedules waiting on a person, oldest proposal first. */
  schedules: readonly Task[];
  /**
   * True while the list is still on its first read.
   *
   * A consumer that draws an all-clear needs to withhold it until the data
   * that would contradict it has actually arrived.
   */
  isLoading: boolean;
}

/**
 * Every schedule parked for the operator's approval.
 *
 * **Live without a poll.** It reads the same `['tasks']` query the Tasks page
 * does, and `useTasksSync` — mounted once in the app shell — invalidates that
 * query on the server's `tasks_changed` event. So a schedule an agent proposes
 * in the background appears here within one SSE tick, and disappears the
 * instant it is approved or rejected, without this hook knowing anything about
 * streams.
 *
 * Answers empty when the Tasks subsystem is switched off, because a schedule
 * that cannot run is not waiting on anybody.
 */
export function usePendingScheduleApprovals(): PendingScheduleApprovals {
  const enabled = useTasksEnabled();
  const { data, isLoading } = useTasks(enabled);

  const schedules = useMemo(() => {
    const parked = (data ?? []).filter((task) => task.status === 'pending_approval');
    // Oldest first: the same order every other queue in the cockpit uses, and
    // the one that puts the thing that has been waiting longest at the top.
    parked.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return parked.length === 0 ? NO_SCHEDULES : parked;
  }, [data]);

  return { schedules, isLoading };
}
