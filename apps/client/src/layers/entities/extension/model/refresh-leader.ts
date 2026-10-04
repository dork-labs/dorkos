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
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

/**
 * Make a hook that tells each mounted copy whether it is the one that refreshes.
 *
 * Call once per refreshing hook, at module scope, so its copies share one
 * roster. The roster is kept per `QueryClient`: two clients hold two caches,
 * and a copy under one cannot refresh the other's.
 */
export function createRefreshLeader(): () => () => boolean {
  // Insertion-ordered, so the first entry is the longest-mounted copy; when it
  // unmounts, the next one takes over without a gap.
  const rosters = new WeakMap<QueryClient, Set<symbol>>();
  const rosterOf = (client: QueryClient): Set<symbol> => {
    let roster = rosters.get(client);
    if (!roster) {
      roster = new Set();
      rosters.set(client, roster);
    }
    return roster;
  };

  return function useIsRefreshLeader(): () => boolean {
    const queryClient = useQueryClient();
    const [id] = useState(() => Symbol('refresh-leader'));

    useEffect(() => {
      const roster = rosterOf(queryClient);
      roster.add(id);
      return () => {
        roster.delete(id);
      };
    }, [queryClient, id]);

    return useCallback(() => rosterOf(queryClient).values().next().value === id, [queryClient, id]);
  };
}
