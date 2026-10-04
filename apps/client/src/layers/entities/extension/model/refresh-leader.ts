/**
 * One refresher per event, however many surfaces mount a hook.
 *
 * The bell, Pulse and Home each mount `useExtensionDecisions` and
 * `usePendingExtensionApprovals`, and every copy subscribes to the same
 * events. If every copy invalidated, one event would cancel and restart the
 * read once per copy, and each restart reaches the server. Joining the read in
 * flight instead (`cancelRefetch: false`) is worse: a second event that lands
 * mid-read joins a read that started before it, and the change it announced
 * stays missing until some later event (DOR-2578).
 *
 * So exactly one mounted copy — the longest-mounted one — answers each event,
 * with a plain invalidate: the read in flight is cancelled and a fresh one
 * starts after the latest event, once.
 *
 * @module entities/extension/model/refresh-leader
 */
import { useCallback, useEffect, useState } from 'react';

/**
 * Make a hook that tells each mounted copy whether it is the one that refreshes.
 *
 * Call once per refreshing hook, at module scope, so its copies share one
 * roster.
 */
export function createRefreshLeader(): () => () => boolean {
  // Insertion-ordered, so the first entry is the longest-mounted copy; when it
  // unmounts, the next one takes over without a gap.
  const mounted = new Set<symbol>();

  return function useIsRefreshLeader(): () => boolean {
    const [id] = useState(() => Symbol('refresh-leader'));

    useEffect(() => {
      mounted.add(id);
      return () => {
        mounted.delete(id);
      };
    }, [id]);

    return useCallback(() => mounted.values().next().value === id, [id]);
  };
}
