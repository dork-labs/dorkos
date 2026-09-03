import { useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import type { BackgroundTaskPart, BackgroundTaskStatus } from '@dorkos/shared/types';
import { useRenderSlot } from '@/layers/shared/lib';
import type { ChatMessage } from './chat-types';

/** A background task with a stable color assignment, ready for display. */
export interface VisibleBackgroundTask {
  taskId: string;
  taskType: 'agent' | 'bash';
  status: BackgroundTaskStatus;
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

/**
 * Five-color pool shared across all visible tasks.
 *
 * The app's own categorical palette (`--chart-1..5`), which is the answer to "N
 * same-kind things that must be told apart" everywhere else — `ChartNode` reads
 * the same five. Tokens rather than literals because the palette is tuned per
 * theme: a green that reads on a white page is too dark on a black one.
 */
export const TASK_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
] as const;

/** Minimum elapsed time (ms) before a bash task appears in the bar. */
const BASH_VISIBILITY_THRESHOLD_MS = 5000;

/** Re-evaluation interval (ms) for bash tasks still below the visibility threshold. */
const BASH_TIMER_INTERVAL_MS = 1000;

/** How long (ms) a just-completed task stays visible (celebration window). */
const CELEBRATION_DURATION_MS = 1500;

/** Stable empty set so the initial celebration state keeps one identity across renders. */
const NO_CELEBRATIONS: ReadonlySet<string> = new Set();

/**
 * Derive visible background tasks from the message stream.
 *
 * Agent tasks appear immediately when running. Bash tasks are suppressed until
 * they have been running for at least 5 seconds, preventing UI churn from
 * short-lived commands. All tasks remain visible for 1500ms after completion
 * (celebration window). Colors are pinned per task from a stable 5-color pool,
 * the first time a task is drawn — a task keeps its color for as long as it
 * exists, and one nobody ever sees never takes a slot out of the pool.
 *
 * @param messages - The current chat message list to scan for BackgroundTaskPart entries.
 */
export function useBackgroundTasks(messages: ChatMessage[]): VisibleBackgroundTask[] {
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  // Each task's colour, pinned the first time it is actually DRAWN. A render
  // slot rather than a ref because the list below is built during render and has
  // to read it; the write is idempotent (a task that already has a colour keeps
  // it), so a render React discards costs nothing.
  const colors = useRenderSlot<{ byTask: Map<string, string>; assigned: number }>({
    byTask: new Map(),
    assigned: 0,
  });
  // Celebrating tasks are state, not a ref: the visible-task list below is
  // computed during render and has to see them, and render cannot read refs.
  const [celebrating, setCelebrating] = useState<ReadonlySet<string>>(NO_CELEBRATIONS);
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

  // Detect running→terminal transitions. A layout effect, not a plain one: the
  // celebration has to be committed before the browser paints, or the finished
  // task blinks out for a frame and back in. The previous status lives in a ref
  // because it is bookkeeping the render never reads.
  useLayoutEffect(() => {
    for (const [taskId, part] of taskMap) {
      const prevStatus = prevStatusRef.current.get(taskId);
      // A negative check on purpose: `running` is the only status still in flight,
      // so enumerating the terminal ones would silently stop celebrating the day a
      // new one lands (`untracked` did exactly that, DOR-1108).
      if (prevStatus === 'running' && part.status !== 'running') {
        setCelebrating((prev) => (prev.has(taskId) ? prev : new Set(prev).add(taskId)));
      }
      prevStatusRef.current.set(taskId, part.status);
    }
  }, [taskMap]);

  // Schedule celebration expiry timers in an effect (side-effect).
  // Only schedules timers for newly celebrating tasks to avoid resetting countdowns.
  useEffect(() => {
    for (const taskId of celebrating) {
      if (timerSetRef.current.has(taskId)) continue;
      timerSetRef.current.add(taskId);

      setTimeout(() => {
        timerSetRef.current.delete(taskId);
        setCelebrating((prev) => {
          if (!prev.has(taskId)) return prev;
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }, CELEBRATION_DURATION_MS);
    }
  }, [celebrating]);

  // Build the visible task list
  return useMemo(() => {
    // eslint-disable-next-line react-hooks/purity -- Date.now() is intentional for visibility threshold filtering
    const now = Date.now();
    const result: VisibleBackgroundTask[] = [];

    const pinned = colors.read();
    let assigned = pinned.assigned;

    for (const [taskId, part] of taskMap) {
      const isRunning = part.status === 'running';
      const isCelebrating = celebrating.has(taskId);

      if (!isRunning && !isCelebrating) continue;

      // Suppress bash tasks that haven't reached the 5-second visibility threshold
      if (
        part.taskType === 'bash' &&
        isRunning &&
        now - part.startedAt < BASH_VISIBILITY_THRESHOLD_MS
      ) {
        continue;
      }

      // The colour is pinned to the taskId the first time the task is drawn, and
      // never moves again: a task keeps its colour for as long as it exists, and
      // a task nobody ever sees — a bash command that finished inside the
      // five-second threshold, or history that was terminal before this client
      // loaded — never takes a slot out of the pool.
      let color = pinned.byTask.get(taskId);
      if (color === undefined) {
        color = TASK_COLORS[assigned % TASK_COLORS.length]!;
        assigned += 1;
        pinned.byTask.set(taskId, color);
        // The map and the counter move together, so a render React discards
        // cannot leave one ahead of the other and hand two live tasks one colour.
        colors.write({ byTask: pinned.byTask, assigned });
      }

      result.push({
        taskId: part.taskId,
        taskType: part.taskType,
        status: part.status,
        color,
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
  }, [taskMap, celebrating, colors]);
}
