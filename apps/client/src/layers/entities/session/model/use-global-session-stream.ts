/**
 * Global session-stream wiring (spec chat-stream-reconnection, Phase 4 / #11).
 *
 * Mounted ONCE at the app shell. Opens the global `/api/events` session-list
 * stream and reflects the live {@link useSessionListStore} `sessions` map into the
 * shared TanStack Query session-list cache ({@link sessionKeys.list}), so the sidebar and every other
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
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';
import { syncSessionDetailCache } from '../lib/sync-session-detail-cache';

/**
 * Invalidate the cross-agent Recent-sessions query (DOR-329) so the sidebar's
 * "Recent" section stays live as sessions are created/updated across agents.
 * Rides the same global-stream → cache bridge (ADR-0265) as the per-cwd caches,
 * alongside the hook's 30s staleTime. A prefix key invalidates every limit.
 *
 * @param queryClient - The TanStack Query client whose recent-sessions query to refresh.
 */
function invalidateRecentSessions(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: sessionKeys.recentRoot });
}

/**
 * Invalidate the machine-wide week count behind the Activity tab's summary line
 * (DOR-1039). A prefix key invalidates every window width.
 *
 * Called only when the SET of live sessions changed, never on a plain update:
 * the query counts sessions per day across every agent, which one streaming
 * turn's many upserts cannot move, and each refetch re-reads every agent's
 * transcript directory.
 *
 * @param queryClient - The TanStack Query client whose week-count query to refresh.
 */
function invalidateSessionDailyCounts(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: sessionKeys.dailyCountsRoot });
}

/**
 * Whether two session maps hold a different SET of ids — the only transition
 * that can change how many sessions a day has seen.
 *
 * @param next - The new `sessions` map from the list store.
 * @param prev - The previously reconciled `sessions` map.
 */
function sessionIdsChanged(next: Record<string, Session>, prev: Record<string, Session>): boolean {
  const nextIds = Object.keys(next);
  if (nextIds.length !== Object.keys(prev).length) return true;
  return nextIds.some((id) => !(id in prev));
}

/**
 * Upsert a single session into its cwd-keyed {@link sessionKeys.list} cache, keeping the
 * list sorted most-recent-first (the order `sessionRouteLoader` relies on).
 */
function upsertSessionInCache(queryClient: QueryClient, session: Session): void {
  queryClient.setQueryData<Session[]>(sessionKeys.list(session.cwd ?? null), (old) => {
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
  queryClient.setQueryData<Session[]>(sessionKeys.list(cwd), (old) =>
    old ? old.filter((s) => s.id !== id) : old
  );
}

/**
 * Resolve newly-retired request UUIDs in EVERY session-list cache. The
 * placeholder row a first message optimistically inserts under the client UUID
 * is never in the list store (only the canonical id is ever upserted from
 * disk), so the map reconcile above can't touch it — without this sweep the
 * rail shows a dead "Session <uuid>" duplicate beside the canonical row until
 * a full refetch (NF-3, acceptance run 20260611-145454). When the canonical
 * row has not landed yet (the common case — the retire announce precedes the
 * disk watcher's upsert), the placeholder is RE-IDed rather than dropped,
 * mirroring the 202 path's optimistic re-insert, so the session the operator
 * is actively driving never vanishes from the rail; once the canonical row
 * exists the placeholder is a duplicate and is dropped. Swept across all cwd
 * keys because the retire announce's `cwd` is optional while the placeholder
 * was keyed by the operator's `selectedCwd`.
 *
 * Every key under {@link sessionKeys.listRoot} is rewritten as an array here, so
 * that prefix must never gain an entry holding anything else — the cross-agent
 * recent-sessions envelope used to live under it and this sweep threw on it
 * (DOR-497).
 *
 * @param queryClient - The TanStack Query client whose caches to sweep.
 * @param next - The new `rekeys` map from the list store.
 * @param prev - The previously reconciled `rekeys` map.
 * @internal Exported for testing.
 */
export function reconcileRetiredSessions(
  queryClient: QueryClient,
  next: Record<string, string>,
  prev: Record<string, string>
): void {
  const retired = new Set(Object.keys(next).filter((id) => !(id in prev)));
  if (retired.size === 0) return;
  queryClient.setQueriesData<Session[]>({ queryKey: sessionKeys.listRoot }, (old) => {
    if (!old?.some((s) => retired.has(s.id))) return old;
    return old.flatMap((row) => {
      if (!retired.has(row.id)) return [row];
      const canonical = next[row.id]!;
      const canonicalExists = old.some((s) => s.id === canonical);
      return canonicalExists ? [] : [{ ...row, id: canonical }];
    });
  });
}

/**
 * Reconcile a {@link useSessionListStore} `sessions`-map transition into the
 * {@link sessionKeys.list} query caches. Patches ONLY the sessions whose object
 * identity changed (immer preserves identity for untouched entries) and removes
 * ids dropped from the map — never rebuilds a cache wholesale.
 *
 * Each changed row also refreshes that session's cached detail entry
 * ({@link syncSessionDetailCache}). The two caches describe the same session and
 * surfaces read both, so a live update that reached only one of them left the
 * other outranking it with older news (DOR-496).
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
  // The store notifies its subscribers synchronously, so this is the instant the
  // frame arrived — the earliest moment about this answer the client can
  // observe. See the sync's own note on the hop it therefore cannot account for.
  const observedAt = Date.now();
  const changed: Session[] = [];
  for (const [id, session] of Object.entries(next)) {
    if (prev[id] === session) continue; // unchanged reference → skip
    upsertSessionInCache(queryClient, session);
    changed.push(session);
  }
  syncSessionDetailCache(queryClient, changed, observedAt);
  for (const [id, session] of Object.entries(prev)) {
    if (next[id]) continue;
    removeSessionFromCache(queryClient, id, session.cwd ?? null);
  }
}

/**
 * Open the global session-list stream and keep the {@link sessionKeys.list} query
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
    let prevRekeys: Record<string, string> = {};
    const unsubscribe = useSessionListStore.subscribe((state) => {
      if (state.sessions !== prev) {
        reconcileSessionsCache(queryClient, state.sessions, prev);
        // Keep the cross-agent Recent section (DOR-329) live on lifecycle events.
        invalidateRecentSessions(queryClient);
        // The week count moves only when a session appears or disappears.
        if (sessionIdsChanged(state.sessions, prev)) invalidateSessionDailyCounts(queryClient);
        prev = state.sessions;
      }
      if (state.rekeys !== prevRekeys) {
        reconcileRetiredSessions(queryClient, state.rekeys, prevRekeys);
        prevRekeys = state.rekeys;
      }
    });

    // The whole list is stale — a Claude account switch changed which stores the
    // server reads (spec `claude-code-accounts` D5). This is the one event that
    // names nothing specific, because the restarted watcher upserts the sessions
    // from the roots it now watches and never announces the ones it stopped
    // watching as removed: only dropping what we hold and asking again converges.
    const unsubscribeInvalidated = streamManager.subscribeEvent('session_list_invalidated', () => {
      useSessionListStore.getState().dropSessions();
      void queryClient.invalidateQueries({ queryKey: sessionKeys.listRoot });
      invalidateRecentSessions(queryClient);
      // The whole list is being re-read, so the count derived from it is stale too.
      invalidateSessionDailyCounts(queryClient);
    });

    // Reconcile whatever already landed (the singleton store survives unmount /
    // HMR), THEN connect. Subscribe → reconcile-current → connect guarantees the
    // cache reflects both pre-existing and subsequent sessions.
    const initial = useSessionListStore.getState();
    if (Object.keys(initial.sessions).length > 0) {
      reconcileSessionsCache(queryClient, initial.sessions, prev);
      prev = initial.sessions;
    }
    if (Object.keys(initial.rekeys).length > 0) {
      reconcileRetiredSessions(queryClient, initial.rekeys, prevRekeys);
      prevRekeys = initial.rekeys;
    }
    streamManager.connectList();

    return () => {
      unsubscribe();
      unsubscribeInvalidated();
    };
  }, [queryClient]);
}
