/**
 * Pulse freshness bridge — makes the Pulse Activity teaser live off the shared
 * `/api/events` SSE stream instead of waiting on its 30s poll.
 *
 * WHAT THIS DOES (and, just as importantly, what it honestly cannot):
 *
 * Pulse has two sections — Needs attention and Activity — assembled from
 * existing models. Their liveness is NOT uniform, because the server's event
 * topology is not uniform:
 *
 *  • **Attention → stalled sessions** already updates live: `useAttentionItems`
 *    reads the `['sessions', cwd]` cache, which `useGlobalSessionStream` keeps in
 *    lockstep with the `session_upserted`/`session_removed` list events (ADR-0265).
 *    The stalled-vs-idle threshold is time-based and re-derives on the `useNow`
 *    tick. So this bridge deliberately does NOT touch sessions — that would be a
 *    redundant refetch of a cache the list stream already patched.
 *
 *  • **Attention → failed runs, dead letters, offline agents** have NO SSE event
 *    at all. The server writes them to disk/SQLite and never broadcasts on
 *    `/api/events` (task-run + mesh mutations are poll-only; a dead-lettered
 *    message emits no signal — verified against the server, 2026-07). There is
 *    nothing honest to subscribe to, so these keep their existing polling
 *    (`useTaskRuns` while running, `useAggregatedDeadLetters`/`useMeshStatus`
 *    intervals). Inventing an invalidation for an event that doesn't correlate
 *    would be theatre, not freshness.
 *
 *  • **Activity** is a standalone append-only log (`activity_events`): it is fed
 *    ONLY by explicit `activityService.emit(...)` calls after primary ops, NOT
 *    derived from chat/session lifecycle — a new session or completed turn
 *    produces no activity row. Of the operations that DO write activity, only two
 *    families also broadcast on `/api/events`: relay traffic/topology and
 *    extension reloads ({@link ACTIVITY_GENERATING_EVENTS}). Those are exactly
 *    the events this bridge subscribes to. Activity from tasks/mesh/agent ops has
 *    no correlated broadcast and continues to surface on the 30s poll /
 *    window-focus refetch — unchanged and honestly documented.
 *
 * So this hook is, precisely, an **activity-feed** freshness bridge: on any
 * activity-generating broadcast it invalidates the two activity caches Pulse and
 * the dashboard read, coalescing a burst into a single trailing-edge refetch so a
 * flurry of relay messages can't stampede the query.
 *
 * Mount ONCE, high in the tree (the app shell), alongside the other
 * `/api/events` sync hooks. In embedded mode (Obsidian) the in-process transport
 * yields no generic events, so every subscription is an inert no-op there.
 *
 * @module widgets/pulse/model/use-pulse-freshness
 */
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useEventSubscription, type KnownEvent } from '@/layers/shared/model';
import { DASHBOARD_ACTIVITY_QUERY_KEY } from '@/layers/features/dashboard-activity';
import { ACTIVITY_QUERY_KEY } from '@/layers/features/activity-feed-page';

/**
 * The `/api/events` broadcasts that reliably correspond to a new `activity_events`
 * row AND are actually emitted by the server. Derived from the real emit ↔
 * broadcast correlation, not guessed:
 *
 *  - `relay_message` — a relay message was sent/delivered (relay routes emit activity)
 *  - `relay_flow` — a message crossed a binding edge (adapter-manager emits activity)
 *  - `relay_adapters_changed` — an adapter was created/updated/removed (relay-adapters routes emit activity)
 *  - `relay_bindings_changed` — a binding changed (emits activity)
 *  - `extension_reloaded` — an extension was installed/reloaded (extensions routes emit activity)
 *
 * NOT included, deliberately: session-list events (activity is not session-derived),
 * `tunnel_status`/`commands_changed` (own dedicated sync hooks, no activity row),
 * and anything for task-run/mesh/dead-letter (no broadcast exists).
 */
const ACTIVITY_GENERATING_EVENTS = [
  'relay_message',
  'relay_flow',
  'relay_adapters_changed',
  'relay_bindings_changed',
  'extension_reloaded',
] as const satisfies readonly KnownEvent[];

/**
 * Trailing-edge coalescing window (ms). An activity-generating event schedules a
 * refetch this far out; further events within the window fold into the same
 * flush, so a burst yields one invalidation, not one per event.
 */
const COALESCE_MS = 1_200;

/**
 * Subscribe the Pulse/dashboard activity caches to the activity-generating
 * `/api/events` broadcasts, coalescing invalidations on a trailing-edge debounce.
 *
 * @param coalesceMs - Debounce window in milliseconds (default {@link COALESCE_MS});
 *   parameterised for deterministic testing.
 */
export function usePulseFreshness(coalesceMs: number = COALESCE_MS): void {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timerRef.current = null;
    // Both activity caches Pulse (and the dashboard's RecentActivityFeed) read.
    // Invalidating an inactive query (e.g. the full /activity feed when off-route)
    // only marks it stale — it refetches on next mount, never wastefully now.
    void queryClient.invalidateQueries({ queryKey: DASHBOARD_ACTIVITY_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY });
  }, [queryClient]);

  // Trailing-edge debounce: each event pushes the flush out to `coalesceMs` from
  // now, so a burst settles into a single refetch once the burst ends.
  const schedule = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, coalesceMs);
  }, [flush, coalesceMs]);

  // Cancel any pending flush on unmount so a fired timer can't touch an unmounted
  // tree's query client.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  // One subscription per event name (fixed count → rules-of-hooks safe). Every
  // handler funnels into the same coalesced `schedule`, so the union of a burst's
  // events produces exactly one activity refetch.
  useEventSubscription('relay_message', schedule);
  useEventSubscription('relay_flow', schedule);
  useEventSubscription('relay_adapters_changed', schedule);
  useEventSubscription('relay_bindings_changed', schedule);
  useEventSubscription('extension_reloaded', schedule);
}

export { ACTIVITY_GENERATING_EVENTS };
