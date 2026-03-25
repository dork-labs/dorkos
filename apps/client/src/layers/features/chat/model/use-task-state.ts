import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore, useTabVisibility } from '@/layers/shared/model';
import { QUERY_TIMING } from '@/layers/shared/lib';
import type { TaskItem, TaskUpdateEvent, TaskStatus } from '@dorkos/shared/types';

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

/**
 * Strip empty-string and undefined values from an update event's task fields.
 * For TaskUpdate, buildTaskEvent sends `subject: ''` and `status: 'pending'`
 * as defaults when the SDK didn't include them — stripping these prevents
 * overwriting the existing task's real values during the merge.
 */
function stripDefaults(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== '') result[key] = value;
  }
  return result;
}

export interface TaskState {
  tasks: TaskItem[];
  taskMap: Map<string, TaskItem>;
  activeForm: string | null;
  isCollapsed: boolean;
  toggleCollapse: () => void;
  handleTaskEvent: (event: TaskUpdateEvent) => void;
  statusTimestamps: Map<string, { status: TaskStatus; since: number }>;
}

const MAX_VISIBLE = 10;

type StatusTimestampMap = Map<string, { status: TaskStatus; since: number }>;

/** Combined state for tasks and their status timestamps, kept in sync atomically. */
interface TaskInternalState {
  taskMap: Map<string, TaskItem>;
  statusTimestamps: StatusTimestampMap;
  nextId: number;
}

const EMPTY_STATE: TaskInternalState = {
  taskMap: new Map(),
  statusTimestamps: new Map(),
  nextId: 1,
};

/**
 * Manages task state for a session, combining historical tasks from the API
 * with real-time streaming updates.
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
  const [state, setState] = useState<TaskInternalState>(EMPTY_STATE);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Load historical tasks via TanStack Query (invalidated on sync_update)
  const { data: initialTasks } = useQuery({
    queryKey: ['tasks', sessionId, selectedCwd],
    queryFn: () => transport.getTasks(sessionId!, selectedCwd ?? undefined),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    enabled: !!sessionId,
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
      const taskMap = new Map<string, TaskItem>();
      const statusTimestamps: StatusTimestampMap = new Map();
      const now = Date.now();
      for (const task of initialTasks.tasks) {
        taskMap.set(task.id, task);
        statusTimestamps.set(task.id, { status: task.status, since: now });
      }
      setState({ taskMap, statusTimestamps, nextId: initialTasks.tasks.length + 1 });
    } else {
      setState(EMPTY_STATE);
    }
  }, [initialTasks]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleTaskEvent = useCallback((event: TaskUpdateEvent) => {
    setState((prev) => {
      const taskMap = new Map(prev.taskMap);
      const statusTimestamps = new Map(prev.statusTimestamps);
      let { nextId } = prev;
      const now = Date.now();

      if (event.action === 'snapshot') {
        // TodoWrite: full overwrite — clear and rebuild from tasks array
        taskMap.clear();
        statusTimestamps.clear();
        const items = event.tasks ?? [event.task];
        for (const item of items) {
          taskMap.set(item.id, item);
          statusTimestamps.set(item.id, { status: item.status, since: now });
        }
        nextId = items.length + 1;
      } else if (event.action === 'create') {
        const id = String(nextId++);
        taskMap.set(id, { ...event.task, id });
        statusTimestamps.set(id, { status: event.task.status, since: now });
      } else if (event.action === 'update' && event.task.id) {
        const existing = taskMap.get(event.task.id);
        if (existing) {
          taskMap.set(event.task.id, {
            ...existing,
            ...stripDefaults(event.task as unknown as Record<string, unknown>),
          });
          if (event.task.status && event.task.status !== existing.status) {
            statusTimestamps.set(event.task.id, { status: event.task.status, since: now });
          }
        }
      }

      return { taskMap, statusTimestamps, nextId };
    });
  }, []);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  const allTasks = Array.from(state.taskMap.values());
  const sorted = sortTasks(allTasks, state.taskMap);
  const inProgressTask = allTasks.find((t) => t.status === 'in_progress');
  const activeForm = inProgressTask?.activeForm ?? null;

  return {
    tasks: sorted.slice(0, MAX_VISIBLE),
    taskMap: state.taskMap,
    activeForm,
    isCollapsed,
    toggleCollapse,
    handleTaskEvent,
    statusTimestamps: state.statusTimestamps,
  };
}
