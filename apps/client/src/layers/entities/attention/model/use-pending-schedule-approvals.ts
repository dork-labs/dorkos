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
 * **Not every `pending_approval` row belongs here.** A package can ship a
 * schedule switched off, documented as opt-in; discovery still parks it, but
 * nobody has anything to decide about a schedule that is not asking to run
 * (DOR-2059). See {@link isScheduleAwaitingApproval} for the one place that
 * distinction is drawn.
 *
 * @module entities/attention/model/use-pending-schedule-approvals
 */
import { useMemo } from 'react';
import type { Task } from '@dorkos/shared/types';
import {
  isScheduleAwaitingApproval,
  useTasks,
  useTasksEnabledState,
} from '@/layers/entities/tasks';

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
    // A package can ship a schedule switched off, and discovery still parks it
    // at `pending_approval` (the arm gate applies to every first sighting) —
    // but a schedule that is not asking to run is not waiting on anybody
    // (DOR-2059). `isScheduleAwaitingApproval` is the one place that reads
    // `enabled` alongside `status`, so this list and the card, the OS-level
    // knock, and the escalation ladder cannot disagree about which schedules
    // count as pending.
    const parked = (data ?? []).filter((task) => isScheduleAwaitingApproval(task));
    // Oldest first: the same order every other queue in the cockpit uses, and
    // the one that puts the thing that has been waiting longest at the top.
    parked.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return parked.length === 0 ? NO_SCHEDULES : parked;
  }, [data]);

  return { schedules, isLoading: configLoading || isLoading };
}
