import { useState, useCallback } from 'react';

/**
 * Track paths the user has acted on (approved, skipped, or denied).
 *
 * Shared between onboarding and agents-page discovery flows.
 * Acted paths are used to filter candidates out of the visible list.
 *
 * @returns `actedPaths` Set, `markActed` to add a path, and `resetActed` to clear all
 */
export function useActedPaths() {
  const [actedPaths, setActedPaths] = useState<Set<string>>(new Set());

  const markActed = useCallback((path: string) => {
    setActedPaths((prev) => new Set(prev).add(path));
  }, []);

  const resetActed = useCallback(() => {
    setActedPaths(new Set());
  }, []);

  return { actedPaths, markActed, resetActed } as const;
}
