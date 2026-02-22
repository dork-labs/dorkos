import { useRef, useCallback, useEffect, useState } from 'react';
import { useRuns } from './use-runs';

const STORAGE_KEY = 'dorkos-pulse-last-viewed';

interface CompletedRunBadge {
  unviewedCount: number;
  clearBadge: () => void;
}

/**
 * Track Pulse run completions for badge/notification display.
 *
 * Only fires for runs that transition from `running` to a terminal state
 * during the current session. Runs already complete on initial load are not counted.
 *
 * @param enabled - When false, the hook is disabled (Pulse feature gate).
 */
export function useCompletedRunBadge(enabled = true): CompletedRunBadge {
  const { data: runs } = useRuns({ limit: 50 }, enabled);
  const prevRunningIdsRef = useRef<Set<string>>(new Set());
  const unviewedCountRef = useRef(0);
  const [, forceUpdate] = useState(0);

  // Track which runs were previously "running"
  useEffect(() => {
    if (!runs) return;

    const currentRunning = new Set(
      runs.filter((r) => r.status === 'running').map((r) => r.id)
    );
    const prevRunning = prevRunningIdsRef.current;

    // Detect transitions: was running, now terminal
    let newCompletions = 0;
    for (const id of prevRunning) {
      const run = runs.find((r) => r.id === id);
      if (run && run.status !== 'running') {
        newCompletions++;
      }
    }

    if (newCompletions > 0) {
      unviewedCountRef.current += newCompletions;
      forceUpdate((n) => n + 1);
    }

    prevRunningIdsRef.current = currentRunning;
  }, [runs]);

  const clearBadge = useCallback(() => {
    unviewedCountRef.current = 0;
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    forceUpdate((n) => n + 1);
  }, []);

  return {
    unviewedCount: unviewedCountRef.current,
    clearBadge,
  };
}
