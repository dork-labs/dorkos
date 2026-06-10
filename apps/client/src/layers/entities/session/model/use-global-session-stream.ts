/**
 * Global session-stream wiring (spec chat-stream-reconnection, Phase 4 / #11).
 *
 * Mounted ONCE at the app shell. Opens the global `/api/events` session-list
 * stream and reflects the live {@link useSessionListStore} `sessions` map into the
 * shared TanStack Query `['sessions', cwd]` cache, so the sidebar and every other
 * consumer of that cache stay accurate after a hard refresh and update live —
 * with NO timer poll (the 5s/60s poll this replaces is removed from
 * `use-sessions.ts`; ADR-0265).
 *
 * The cache is patched per-session by id and keyed by each session's own `cwd`,
 * so only sessions that actually changed are touched — a cwd the global stream
 * doesn't cover keeps its cold-loaded list intact (no wholesale rebuild/wipe).
 *
 * @module entities/session/model/use-global-session-stream
 */
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import { streamManager } from '@/layers/shared/lib/transport';
import { initSessionStreamBinding } from './session-stream-binding';
import { useSessionListStore } from './session-list-store';

/**
 * Upsert a single session into its cwd-keyed `['sessions', cwd]` cache, keeping the
 * list sorted most-recent-first (the order `sessionRouteLoader` relies on).
 */
function upsertSessionInCache(queryClient: QueryClient, session: Session): void {
  const key = ['sessions', session.cwd ?? null] as const;
  queryClient.setQueryData<Session[]>(key, (old) => {
    const list = old ?? [];
    const next = list.some((s) => s.id === session.id)
      ? list.map((s) => (s.id === session.id ? session : s))
      : [session, ...list];
    // `next` is always a freshly-allocated array here, so sorting in place is safe.
    return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
}

/** Remove a session by id from its (last-known) cwd-keyed cache. */
function removeSessionFromCache(queryClient: QueryClient, id: string, cwd: string | null): void {
  queryClient.setQueryData<Session[]>(['sessions', cwd], (old) =>
    old ? old.filter((s) => s.id !== id) : old
  );
}

/**
 * Reconcile a {@link useSessionListStore} `sessions`-map transition into the
 * `['sessions', cwd]` query caches. Patches ONLY the sessions whose object
 * identity changed (immer preserves identity for untouched entries) and removes
 * ids dropped from the map — never rebuilds a cache wholesale.
 *
 * @param queryClient - The TanStack Query client whose caches to patch.
 * @param next - The new `sessions` map from the list store.
 * @param prev - The previously reconciled `sessions` map.
 * @internal Exported for testing.
 */
export function reconcileSessionsCache(
  queryClient: QueryClient,
  next: Record<string, Session>,
  prev: Record<string, Session>
): void {
  for (const [id, session] of Object.entries(next)) {
    if (prev[id] === session) continue; // unchanged reference → skip
    upsertSessionInCache(queryClient, session);
  }
  for (const [id, session] of Object.entries(prev)) {
    if (next[id]) continue;
    removeSessionFromCache(queryClient, id, session.cwd ?? null);
  }
}

/**
 * Open the global session-list stream and keep the `['sessions', cwd]` query
 * caches in sync with the live store. Call exactly once, high in the tree
 * (the app shell). Idempotent connection setup (StrictMode/HMR-safe).
 */
export function useGlobalSessionStream(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    initSessionStreamBinding();

    // Order matters: subscribe BEFORE connecting, so no list frame delivered by
    // the global stream lands in the store between the snapshot read and the
    // subscription (an event-loss window that would leave the cache stale after
    // a hard refresh, and would not self-heal for one-shot `session_removed`).
    let prev: Record<string, Session> = {};
    const unsubscribe = useSessionListStore.subscribe((state) => {
      const nextSessions = state.sessions;
      if (nextSessions === prev) return; // statuses-only change → ignore
      reconcileSessionsCache(queryClient, nextSessions, prev);
      prev = nextSessions;
    });

    // Reconcile whatever already landed (the singleton store survives unmount /
    // HMR), THEN connect. Subscribe → reconcile-current → connect guarantees the
    // cache reflects both pre-existing and subsequent sessions.
    const initial = useSessionListStore.getState().sessions;
    if (Object.keys(initial).length > 0) {
      reconcileSessionsCache(queryClient, initial, prev);
      prev = initial;
    }
    streamManager.connectList();

    return unsubscribe;
  }, [queryClient]);
}
