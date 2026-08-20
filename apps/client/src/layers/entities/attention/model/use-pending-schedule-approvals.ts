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
import { useTasks, useTasksEnabledState } from '@/layers/entities/tasks';

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
  // **The config read's own pending state, not `!enabled`.** The task query is
  // gated on `enabled`, and a disabled TanStack query reports `isLoading:
  // false` — so while the config was still in flight this hook said "settled,
  // nothing parked". Anything watching for arrivals seeded an empty known set
  // from that, and every schedule that had been sitting there for days was
  // announced as a new arrival the moment the config landed: a knock and an OS
  // banner for nothing. It is reachable in the ordinary app, because `AppShell`
  // gives up waiting on config after three seconds and renders anyway
  // (DOR-1391).
  const { enabled, isLoading: configLoading } = useTasksEnabledState();
  const { data, isLoading } = useTasks(enabled);

  const schedules = useMemo(() => {
    const parked = (data ?? []).filter((task) => task.status === 'pending_approval');
    // Oldest first: the same order every other queue in the cockpit uses, and
    // the one that puts the thing that has been waiting longest at the top.
    parked.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return parked.length === 0 ? NO_SCHEDULES : parked;
  }, [data]);

  return { schedules, isLoading: configLoading || isLoading };
}
