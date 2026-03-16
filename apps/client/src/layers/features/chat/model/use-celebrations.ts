import { useRef, useEffect, useCallback, useState } from 'react';
import { useAppStore, useIdleDetector } from '@/layers/shared/model';
import { CelebrationEngine, CELEBRATIONS, type CelebrationEvent } from '@/layers/shared/lib';
import type { TaskItem, TaskUpdateEvent } from '@dorkos/shared/types';

export interface CelebrationsAPI {
  /** Wraps useTaskState.handleTaskEvent to intercept completions */
  handleTaskEvent: (event: TaskUpdateEvent, allTasks: TaskItem[]) => void;
  /** Currently active celebration (for rendering) */
  activeCelebration: CelebrationEvent | null;
  /** ID of task currently celebrating (for inline mini effects) */
  celebratingTaskId: string | null;
  /** Clear the active celebration after animation completes */
  clearCelebration: () => void;
}

/** Manages task completion celebration effects with idle detection and reduced-motion support. */
export function useCelebrations(): CelebrationsAPI {
  const showTaskCelebrations = useAppStore((s) => s.showTaskCelebrations);
  const [activeCelebration, setActiveCelebration] = useState<CelebrationEvent | null>(null);
  const [celebratingTaskId, setCelebratingTaskId] = useState<string | null>(null);
  const engineRef = useRef<CelebrationEngine | null>(null);
  const prefersReducedMotion = useRef(false);

  // Check prefers-reduced-motion on mount
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion.current = mql.matches;
    const handler = (e: MediaQueryListEvent) => {
      prefersReducedMotion.current = e.matches;
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Idle detection
  useIdleDetector({
    timeoutMs: CELEBRATIONS.IDLE_TIMEOUT_MS,
    onIdle: useCallback(() => {
      engineRef.current?.setIdle(true);
    }, []),
    onReturn: useCallback(() => {
      engineRef.current?.setIdle(false);
      engineRef.current?.onUserReturn();
    }, []),
  });

  // Initialize celebration engine
  useEffect(() => {
    const engine = new CelebrationEngine({
      enabled: showTaskCelebrations,
      miniProbability: CELEBRATIONS.MINI_PROBABILITY,
      debounceWindowMs: CELEBRATIONS.DEBOUNCE_WINDOW_MS,
      debounceThreshold: CELEBRATIONS.DEBOUNCE_THRESHOLD,
      minTasksForMajor: CELEBRATIONS.MIN_TASKS_FOR_MAJOR,
      idleTimeoutMs: CELEBRATIONS.IDLE_TIMEOUT_MS,
      onCelebrate: (event) => {
        if (prefersReducedMotion.current && event.level === 'major') {
          // Reduced motion: downgrade major to mini (skip confetti/glow)
          setActiveCelebration({ ...event, level: 'mini' });
        } else {
          setActiveCelebration(event);
        }
        if (event.level === 'mini') {
          setCelebratingTaskId(event.taskId);
        }
      },
    });

    engineRef.current = engine;
    return () => engine.destroy();
  }, [showTaskCelebrations]);

  const handleTaskEvent = useCallback((event: TaskUpdateEvent, allTasks: TaskItem[]) => {
    // Only celebrate live update transitions to 'completed'
    if (event.action === 'update' && event.task.status === 'completed' && event.task.id) {
      engineRef.current?.onTaskCompleted(event.task.id, allTasks);
    }
  }, []);

  const clearCelebration = useCallback(() => {
    setActiveCelebration(null);
    setCelebratingTaskId(null);
  }, []);

  return {
    handleTaskEvent,
    activeCelebration,
    celebratingTaskId,
    clearCelebration,
  };
}
