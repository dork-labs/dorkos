import { useState, useEffect } from 'react';

const STORAGE_KEY = 'dorkos:lastVisitedDashboard';

/**
 * Track the last time the dashboard was visited using localStorage.
 * Reads the previous timestamp on mount, then immediately updates it.
 * Returns null on first visit.
 */
export function useLastVisited(): string | null {
  const [lastVisitedAt, setLastVisitedAt] = useState<string | null>(null);

  useEffect(() => {
    // Read before writing so we capture the previous visit
    const stored = localStorage.getItem(STORAGE_KEY);
    setLastVisitedAt(stored);
    // Write current timestamp for next visit to read
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
  }, []);

  return lastVisitedAt;
}
