import { useState, useCallback, useEffect, useRef } from 'react';
import { useTransport } from '../contexts/TransportContext';
import { useAppStore } from '../stores/app-store';
import type { TaskItem, TaskUpdateEvent, TaskStatus } from '@lifeos/shared/types';

const STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
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
  activeForm: string | null;
  isCollapsed: boolean;
  toggleCollapse: () => void;
  handleTaskEvent: (event: TaskUpdateEvent) => void;
}

const MAX_VISIBLE = 10;

export function useTaskState(sessionId: string): TaskState {
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const [taskMap, setTaskMap] = useState<Map<string, TaskItem>>(new Map());
  const [isCollapsed, setIsCollapsed] = useState(false);
  const nextIdRef = useRef(1);

  // Load historical tasks when sessionId changes
  useEffect(() => {
    setTaskMap(new Map());
    nextIdRef.current = 1;
    transport.getTasks(sessionId, selectedCwd ?? undefined).then(({ tasks }) => {
      if (tasks.length > 0) {
        const map = new Map<string, TaskItem>();
        for (const task of tasks) {
          map.set(task.id, task);
        }
        setTaskMap(map);
        nextIdRef.current = tasks.length + 1;
      }
    }).catch(() => {});
  }, [sessionId, transport, selectedCwd]);

  const handleTaskEvent = useCallback((event: TaskUpdateEvent) => {
    setTaskMap(prev => {
      const next = new Map(prev);
      if (event.action === 'create') {
        const id = String(nextIdRef.current++);
        next.set(id, { ...event.task, id });
      } else if (event.action === 'update' && event.task.id) {
        const existing = next.get(event.task.id);
        if (existing) {
          next.set(event.task.id, { ...existing, ...stripDefaults(event.task as unknown as Record<string, unknown>) });
        }
      }
      return next;
    });
  }, []);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  const allTasks = Array.from(taskMap.values());
  const sorted = sortTasks(allTasks);
  const inProgressTask = allTasks.find(t => t.status === 'in_progress');
  const activeForm = inProgressTask?.activeForm ?? null;

  return {
    tasks: sorted.slice(0, MAX_VISIBLE),
    activeForm,
    isCollapsed,
    toggleCollapse,
    handleTaskEvent,
  };
}
