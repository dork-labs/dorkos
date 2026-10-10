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

/** How often the shell re-reads management requests, which no event announces. */
const REVIEWS_POLL_MS = 5 * 60_000;

/** Whether a schedule can run now: approved and switched on. */
function isLive(task: Pick<Task, 'status' | 'enabled'>): boolean {
  return task.status === 'active' && task.enabled;
}

/**
 * The Schedules tab: waiting for your OK, a failed last run, or running. Also
 * hands the window title how many schedules wait for your OK.
 *
 * @param waiting - Schedules waiting for your OK, from the waiting queue.
 */
function useSchedulesBadge(waiting: number): void {
  const { enabled } = useTasksEnabledState();
  const { data: tasks } = useTasks(enabled);
  const { data: runs } = useRecentTaskRuns(enabled);
  const setSchedulesWaiting = useTabSignalsStore((state) => state.setSchedulesWaitingCount);

  const input = useMemo(() => {
    const summary = summarizeRecentRuns(enabled ? (runs ?? []) : []);
    // Only schedules that can run now. A run whose schedule is gone, paused or
    // switched off has nothing to fix until it runs again, so its old failure
    // does not stick to the tab.
    const byId = new Map((tasks ?? []).filter(isLive).map((task) => [task.id, task]));
    return {
      waiting,
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

  useEffect(() => {
    setSchedulesWaiting(waiting);
  }, [waiting, setSchedulesWaiting]);
}

/** The Activity tab: events since you last opened Activity. */
function useActivityBadge(): void {
  const { count, more } = useNewActivityCount();
  const badge = useMemo(() => activityBadge(count, more), [count, more]);
  useRouteBadge('/activity', badge);
}

/**
 * The Connections tab: only requests waiting for your OK. Narrower than the
 * page's Needs you list, which also keeps decided requests that still need a
 * sign-in or a check.
 */
function useConnectionsBadge(): void {
  const { data: requests, isSuccess: canSee } = useConnectorAgentRequests('pending');
  // Both lists are the owner's alone. The agent requests read (live on its own
  // event) answers whether this viewer is the owner; the management requests
  // are read only once it has, so nobody else logs a refusal every load.
  const { data: reviews } = useConnectorManagementReviews('pending', {
    enabled: canSee,
    refetchInterval: REVIEWS_POLL_MS,
  });
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
