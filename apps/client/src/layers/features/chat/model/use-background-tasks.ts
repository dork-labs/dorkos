import { useMemo, useRef, useState, useEffect } from 'react';
import type { BackgroundTaskPart } from '@dorkos/shared/types';
import type { ChatMessage } from './chat-types';

/** A background task with a stable color assignment, ready for display. */
export interface VisibleBackgroundTask {
  taskId: string;
  taskType: 'agent' | 'bash';
  status: 'running' | 'complete' | 'error' | 'stopped';
  color: string;
  startedAt: number;
  // Agent-specific
  description?: string;
  toolUses?: number;
  lastToolName?: string;
  durationMs?: number;
  summary?: string;
  // Bash-specific
  command?: string;
}

/** Five-color pool shared across all visible tasks, matching the agent color palette. */
export const TASK_COLORS = [
  'hsl(210 80% 60%)', // blue
  'hsl(150 60% 50%)', // green
  'hsl(270 60% 65%)', // purple
  'hsl(36 90% 55%)', // amber
  'hsl(340 75% 60%)', // rose
] as const;

/** Minimum elapsed time (ms) before a bash task appears in the bar. */
const BASH_VISIBILITY_THRESHOLD_MS = 5000;

/** Re-evaluation interval (ms) for bash tasks still below the visibility threshold. */
const BASH_TIMER_INTERVAL_MS = 1000;

/** How long (ms) a just-completed task stays visible (celebration window). */
const CELEBRATION_DURATION_MS = 1500;

/**
 * Derive visible background tasks from the message stream.
 *
 * Agent tasks appear immediately when running. Bash tasks are suppressed until
 * they have been running for at least 5 seconds, preventing UI churn from
 * short-lived commands. All tasks remain visible for 1500ms after completion
 * (celebration window). Colors are assigned from a stable 5-color pool.
 *
 * @param messages - The current chat message list to scan for BackgroundTaskPart entries.
 */
export function useBackgroundTasks(messages: ChatMessage[]): VisibleBackgroundTask[] {
  const colorMapRef = useRef<Map<string, string>>(new Map());
  const colorIndexRef = useRef(0);
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const celebratingRef = useRef<Set<string>>(new Set());
  const [, setRenderTick] = useState(0);

  // Collect the latest BackgroundTaskPart per taskId across all messages
  const taskMap = useMemo(() => {
    const map = new Map<string, BackgroundTaskPart>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === 'background_task') {
          map.set(part.taskId, part);
        }
      }
    }
    return map;
  }, [messages]);

  // Timer to re-evaluate bash tasks that are still below the 5s threshold.
  // Runs only while pending bash tasks exist; cleaned up on unmount or when none remain.
  useEffect(() => {
    const hasPendingBash = Array.from(taskMap.values()).some(
      (t) =>
        t.taskType === 'bash' &&
        t.status === 'running' &&
        Date.now() - t.startedAt < BASH_VISIBILITY_THRESHOLD_MS
    );

    if (!hasPendingBash) return;

    const interval = setInterval(() => {
      setRenderTick((tick) => tick + 1);
    }, BASH_TIMER_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [taskMap]);

  // Track which tasks already have expiry timers to avoid double-scheduling
  const timerSetRef = useRef<Set<string>>(new Set());

  // Detect running→terminal transitions synchronously so celebratingRef is
  // up-to-date before the useMemo below reads it during the same render.
  for (const [taskId, part] of taskMap) {
    const prevStatus = prevStatusRef.current.get(taskId);
    const isTerminal =
      part.status === 'complete' || part.status === 'error' || part.status === 'stopped';
    const justCompleted = prevStatus === 'running' && isTerminal;

    if (justCompleted && !celebratingRef.current.has(taskId)) {
      celebratingRef.current.add(taskId);
    }

    prevStatusRef.current.set(taskId, part.status);
  }

  // Schedule celebration expiry timers in an effect (side-effect).
  // Only schedules timers for newly celebrating tasks to avoid resetting countdowns.
  useEffect(() => {
    for (const taskId of celebratingRef.current) {
      if (timerSetRef.current.has(taskId)) continue;
      timerSetRef.current.add(taskId);

      setTimeout(() => {
        celebratingRef.current.delete(taskId);
        timerSetRef.current.delete(taskId);
        setRenderTick((tick) => tick + 1);
      }, CELEBRATION_DURATION_MS);
    }
  }, [taskMap]);

  // Build the visible task list
  return useMemo(() => {
    const now = Date.now();
    const result: VisibleBackgroundTask[] = [];

    for (const [taskId, part] of taskMap) {
      const isRunning = part.status === 'running';
      const isCelebrating = celebratingRef.current.has(taskId);

      if (!isRunning && !isCelebrating) continue;

      // Suppress bash tasks that haven't reached the 5-second visibility threshold
      if (
        part.taskType === 'bash' &&
        isRunning &&
        now - part.startedAt < BASH_VISIBILITY_THRESHOLD_MS
      ) {
        continue;
      }

      // Assign stable color from the shared pool
      if (!colorMapRef.current.has(taskId)) {
        colorMapRef.current.set(taskId, TASK_COLORS[colorIndexRef.current % TASK_COLORS.length]);
        colorIndexRef.current += 1;
      }

      result.push({
        taskId: part.taskId,
        taskType: part.taskType,
        status: part.status,
        color: colorMapRef.current.get(taskId)!,
        startedAt: part.startedAt,
        description: part.description,
        toolUses: part.toolUses,
        lastToolName: part.lastToolName,
        durationMs: part.durationMs,
        summary: part.summary,
        command: part.command,
      });
    }

    return result;
    // celebratingRef is a ref — renderTick (state) drives re-computation when celebrations expire
  }, [taskMap /* renderTick drives re-computation via state change */]);
}
