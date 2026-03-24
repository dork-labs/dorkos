import { useState, useCallback, useEffect, useRef } from 'react';
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
  const [taskMap, setTaskMap] = useState<Map<string, TaskItem>>(new Map());
  const [isCollapsed, setIsCollapsed] = useState(false);
  const nextIdRef = useRef(1);
  const statusTimestampsRef = useRef<Map<string, { status: TaskStatus; since: number }>>(new Map());

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

  // Reset taskMap when query data changes (initial load or sync invalidation)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Idiomatic: reset state when query data changes
    setTaskMap(new Map());
    nextIdRef.current = 1;
    statusTimestampsRef.current = new Map();

    if (initialTasks && initialTasks.tasks.length > 0) {
      const map = new Map<string, TaskItem>();
      const now = Date.now();
      for (const task of initialTasks.tasks) {
        map.set(task.id, task);
        statusTimestampsRef.current.set(task.id, { status: task.status, since: now });
      }
      setTaskMap(map);
      nextIdRef.current = initialTasks.tasks.length + 1;
    }
  }, [initialTasks]);

  const handleTaskEvent = useCallback((event: TaskUpdateEvent) => {
    setTaskMap((prev) => {
      const next = new Map(prev);
      if (event.action === 'snapshot') {
        // TodoWrite: full overwrite — clear and rebuild from tasks array
        next.clear();
        const items = event.tasks ?? [event.task];
        statusTimestampsRef.current = new Map();
        for (const item of items) {
          next.set(item.id, item);
          statusTimestampsRef.current.set(item.id, { status: item.status, since: Date.now() });
        }
        nextIdRef.current = items.length + 1;
      } else if (event.action === 'create') {
        const id = String(nextIdRef.current++);
        next.set(id, { ...event.task, id });
        statusTimestampsRef.current.set(id, { status: event.task.status, since: Date.now() });
      } else if (event.action === 'update' && event.task.id) {
        const existing = next.get(event.task.id);
        if (existing) {
          next.set(event.task.id, {
            ...existing,
            ...stripDefaults(event.task as unknown as Record<string, unknown>),
          });
          if (event.task.status && event.task.status !== existing.status) {
            statusTimestampsRef.current.set(event.task.id, {
              status: event.task.status,
              since: Date.now(),
            });
          }
        }
      }
      return next;
    });
  }, []);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  const allTasks = Array.from(taskMap.values());
  const sorted = sortTasks(allTasks, taskMap);
  const inProgressTask = allTasks.find((t) => t.status === 'in_progress');
  const activeForm = inProgressTask?.activeForm ?? null;

  return {
    tasks: sorted.slice(0, MAX_VISIBLE),
    taskMap,
    activeForm,
    isCollapsed,
    toggleCollapse,
    handleTaskEvent,
    statusTimestamps: statusTimestampsRef.current,
  };
}
