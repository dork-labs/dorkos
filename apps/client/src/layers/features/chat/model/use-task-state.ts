import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore, useTabVisibility } from '@/layers/shared/model';
import { QUERY_TIMING, isSessionRequestReady } from '@/layers/shared/lib';
import type { TaskItem, TaskUpdateEvent, SessionTaskStatus } from '@dorkos/shared/types';
import { applyTaskEvent, createTaskFoldState, type TaskFoldState } from '@dorkos/shared/task-fold';

/** Check if a task is blocked by any incomplete dependency. */
function isTaskBlocked(task: TaskItem, taskMap: Map<string, TaskItem>): boolean {
  if (!task.blockedBy?.length) return false;
  return task.blockedBy.some((depId) => {
    const dep = taskMap.get(depId);
    return dep && dep.status !== 'completed';
  });
}

function sortTasks(tasks: TaskItem[], taskMap: Map<string, TaskItem>): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const aOrder =
      a.status === 'in_progress'
        ? 0
        : a.status === 'pending' && !isTaskBlocked(a, taskMap)
          ? 1
          : a.status === 'pending'
            ? 2
            : 3;
    const bOrder =
      b.status === 'in_progress'
        ? 0
        : b.status === 'pending' && !isTaskBlocked(b, taskMap)
          ? 1
          : b.status === 'pending'
            ? 2
            : 3;
    return aOrder - bOrder;
  });
}

export interface TaskState {
  tasks: TaskItem[];
  taskMap: Map<string, TaskItem>;
  activeForm: string | null;
  isCollapsed: boolean;
  toggleCollapse: () => void;
  handleTaskEvent: (event: TaskUpdateEvent) => void;
  statusTimestamps: Map<string, { status: SessionTaskStatus; since: number }>;
}

const MAX_VISIBLE = 10;

/**
 * Manages task state for a session, combining historical tasks from the API
 * with real-time streaming updates.
 *
 * Both the historical snapshot and the live stream fold through the same
 * {@link applyTaskEvent} the server's JSONL history reader uses
 * (`task-reader.ts`) — DOR-1441 was these two folds drifting apart when each
 * kept its own keying scheme. A `TaskCreate` event carries a provisional id
 * (the SDK's `TaskCreate` tool never returns one synchronously) until an
 * `id_assigned` event re-keys it to the SDK's confirmed real id, or `remove`
 * drops it if the call failed.
 *
 * @param sessionId - The active session ID, or null when no session is selected.
 *   When null, the initial task query is disabled and no API requests are made.
 * @param isStreaming - Whether the session is currently streaming. When true,
 *   polling is disabled to avoid redundant fetches during active streams.
 */
export function useTaskState(sessionId: string | null, isStreaming: boolean = false): TaskState {
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  const isTabVisible = useTabVisibility();
  const [state, setState] = useState<TaskFoldState>(createTaskFoldState());
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Load historical tasks via TanStack Query (polled while a turn streams)
  const { data: initialTasks } = useQuery({
    queryKey: ['tasks', sessionId, selectedCwd],
    queryFn: () => transport.getTasks(sessionId!, selectedCwd!),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    // Waits for the working directory too — a fetch keyed on a directory the
    // store has not resolved yet is one the server always refuses (DOR-495).
    enabled: isSessionRequestReady(sessionId, selectedCwd),
    refetchInterval: () => {
      if (!enableMessagePolling) return false;
      if (isStreaming) return false;
      return isTabVisible
        ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
        : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
    },
  });

  // Reset state when query data changes (initial load or sync invalidation)
  /* eslint-disable react-hooks/set-state-in-effect -- sync TanStack Query data to local state */
  useEffect(() => {
    if (initialTasks && initialTasks.tasks.length > 0) {
      const next = createTaskFoldState();
      applyTaskEvent(
        next,
        { action: 'snapshot', task: initialTasks.tasks[0]!, tasks: initialTasks.tasks },
        Date.now()
      );
      setState(next);
    } else {
      setState(createTaskFoldState());
    }
  }, [initialTasks]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleTaskEvent = useCallback((event: TaskUpdateEvent) => {
    setState((prev) => {
      const next: TaskFoldState = {
        tasks: new Map(prev.tasks),
        statusTimestamps: new Map(prev.statusTimestamps),
        legacyCreateCount: prev.legacyCreateCount,
      };
      applyTaskEvent(next, event, Date.now());
      return next;
    });
  }, []);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  const allTasks = Array.from(state.tasks.values());
  const sorted = sortTasks(allTasks, state.tasks);
  const inProgressTask = allTasks.find((t) => t.status === 'in_progress');
  const activeForm = inProgressTask?.activeForm ?? null;

  return {
    tasks: sorted.slice(0, MAX_VISIBLE),
    taskMap: state.tasks,
    activeForm,
    isCollapsed,
    toggleCollapse,
    handleTaskEvent,
    statusTimestamps: state.statusTimestamps,
  };
}
