/**
 * Keeps the shared tab facts current (DOR-2820): how much is waiting on you,
 * and what Schedules, Activity and Connections report for their own tabs.
 *
 * Read once, at the app shell, and written into `tab-signals.ts`: every tab,
 * the History menu and the window title read that one copy rather than each
 * fetching its own.
 *
 * @module features/app-tabs/model/use-tab-signals-sync
 */
import { useEffect, useMemo } from 'react';
import type { Task } from '@dorkos/shared/types';
import { useNewActivityCount } from '@/layers/entities/activity';
import { useWaitingQueue } from '@/layers/entities/attention';
import {
  summarizeRecentRuns,
  useRecentTaskRuns,
  useTasks,
  useTasksEnabledState,
} from '@/layers/entities/tasks';
import {
  useConnectorAgentRequests,
  useConnectorManagementReviews,
} from '@/layers/entities/connectors';
import {
  activityBadge,
  connectionsBadge,
  schedulesAttentionCount,
  schedulesBadge,
  type RouteBadge,
} from '../lib/tab-identity';
import { useTabSignalsStore } from './tab-signals';

/** The name a schedule goes by on the Schedules page. */
function scheduleName(task: Pick<Task, 'name' | 'displayName'>): string {
  return task.displayName || task.name;
}

/** Write one route's badge whenever it changes. */
function useRouteBadge(path: string, badge: RouteBadge | null): void {
  const setRouteBadge = useTabSignalsStore((state) => state.setRouteBadge);
  useEffect(() => {
    setRouteBadge(path, badge);
  }, [path, badge, setRouteBadge]);
}

/**
 * The Schedules tab: waiting for your OK, a failed last run, or running. Also
 * hands the window title how many schedules want a look.
 *
 * @param waiting - Schedules waiting for your OK, from the waiting queue.
 */
function useSchedulesBadge(waiting: number): void {
  const { enabled } = useTasksEnabledState();
  const { data: tasks } = useTasks(enabled);
  const { data: runs } = useRecentTaskRuns(enabled);
  const setScheduleAttention = useTabSignalsStore((state) => state.setScheduleAttentionCount);

  const input = useMemo(() => {
    const summary = summarizeRecentRuns(enabled ? (runs ?? []) : []);
    const byId = new Map((tasks ?? []).map((task) => [task.id, task]));
    return {
      waiting,
      // A run whose schedule is gone (deleted since) has nobody to fix it.
      failed: summary.failed.filter((id) => byId.has(id)).length,
      running: summary.running.flatMap((id) => {
        const task = byId.get(id);
        return task ? [scheduleName(task)] : [];
      }),
    };
  }, [enabled, runs, tasks, waiting]);

  // A poll that returns the same runs mints an equal badge, which the store
  // drops, so the tab is not rewritten every ten seconds.
  const badge = useMemo(() => schedulesBadge(input), [input]);
  useRouteBadge('/tasks', badge);

  const attention = schedulesAttentionCount(input);
  useEffect(() => {
    setScheduleAttention(attention);
  }, [attention, setScheduleAttention]);
}

/** The Activity tab: events since you last opened Activity. */
function useActivityBadge(): void {
  const count = useNewActivityCount();
  const badge = useMemo(() => activityBadge(count), [count]);
  useRouteBadge('/activity', badge);
}

/** The Connections tab: requests waiting for your OK, as its Needs you lists them. */
function useConnectionsBadge(): void {
  const { data: requests } = useConnectorAgentRequests('pending');
  const { data: reviews } = useConnectorManagementReviews('pending');
  const waiting = (requests?.length ?? 0) + (reviews?.length ?? 0);
  const badge = useMemo(() => connectionsBadge(waiting), [waiting]);
  useRouteBadge('/connections', badge);
}

/**
 * Keep the shared tab facts current. Mount once, at the app shell, so every
 * tab, the History menu and the window title read one copy.
 */
export function useTabSignalsSync(): void {
  const { items, schedules } = useWaitingQueue();
  const setNeedsYouCount = useTabSignalsStore((state) => state.setNeedsYouCount);
  useEffect(() => {
    setNeedsYouCount(items.length);
  }, [items.length, setNeedsYouCount]);
  useSchedulesBadge(schedules.length);
  useActivityBadge();
  useConnectionsBadge();
}
