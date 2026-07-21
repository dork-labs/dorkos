/**
 * Pulse freshness bridge — makes the Pulse Activity teaser and Needs-attention
 * section live off the shared `/api/events` SSE stream instead of waiting on
 * their 30s polls.
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
 *  • **Attention → failed runs, dead letters, offline agents** NOW broadcast on
 *    `/api/events` at their transition points (DOR-403): the TaskStore
 *    run-terminal hook emits `task_run_failed` on the single terminal write that
 *    marks a run failed (covering both scheduler-side and relay-delivered runs),
 *    the relay dead-letter queue emits `relay_dead_letter` when a message is
 *    dead-lettered, and mesh liveness emits `mesh_liveness_changed` when the
 *    reconciler flips an agent offline/online. Each invalidates only its own
 *    attention cache, so the badge and the open panel tick within the coalesce
 *    window instead of on the next 30s poll. A failed run also writes an
 *    `activity_events` row, so it refreshes the activity caches too.
 *
 *  • **Activity** is a standalone append-only log (`activity_events`): it is fed
 *    ONLY by explicit `activityService.emit(...)` calls after primary ops, NOT
 *    derived from chat/session lifecycle — a new session or completed turn
 *    produces no activity row. Of the operations that DO write activity, three
 *    families also broadcast on `/api/events`: relay traffic/topology, extension
 *    reloads, and failed task runs ({@link ACTIVITY_GENERATING_EVENTS}). Those
 *    are exactly the events that refresh the activity caches. Activity from other
 *    mesh/agent ops has no correlated broadcast and continues to surface on the
 *    30s poll / window-focus refetch — unchanged and honestly documented.
 *
 * So this hook is a **freshness bridge**: on any subscribed broadcast it
 * invalidates exactly the caches that broadcast can change, coalescing a burst
 * into a single trailing-edge flush so a flurry of events can't stampede the
 * queries.
 *
 * Mount ONCE, high in the tree (the app shell), alongside the other
 * `/api/events` sync hooks. In embedded mode (Obsidian) the in-process transport
 * yields no generic events, so every subscription is an inert no-op there.
 *
 * @module widgets/pulse/model/use-pulse-freshness
 */
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEventSubscription, type KnownEvent } from '@/layers/shared/model';
import { DASHBOARD_ACTIVITY_QUERY_KEY } from '@/layers/features/dashboard-activity';
import { ACTIVITY_QUERY_KEY } from '@/layers/features/activity-feed-page';
import { TASK_RUNS_KEY } from '@/layers/entities/tasks';
import { DEAD_LETTERS_KEY } from '@/layers/entities/relay';
import { MESH_STATUS_KEY } from '@/layers/entities/mesh';

/** The two activity caches Pulse and the dashboard's RecentActivityFeed read. */
const ACTIVITY_KEYS = [DASHBOARD_ACTIVITY_QUERY_KEY, ACTIVITY_QUERY_KEY] as const;

/**
 * Each subscribed `/api/events` broadcast mapped to the query caches it can
 * change — derived from the real emit ↔ broadcast correlation, not guessed:
 *
 *  - `relay_message` / `relay_flow` / `relay_adapters_changed` /
 *    `relay_bindings_changed` / `extension_reloaded` — write an `activity_events`
 *    row → refresh the activity caches. `relay_message` is slightly
 *    over-inclusive (it fires for every human-console message, while the row is
 *    only written when an adapter was involved) — harmless: the flush is
 *    coalesced and a same-data refetch is cheap.
 *  - `task_run_failed` (DOR-403) — a Tasks run was recorded failed. Refreshes the
 *    failed-runs attention cache AND the activity caches (a failed run also writes
 *    an activity row).
 *  - `relay_dead_letter` (DOR-403) — a message was dead-lettered → refresh the
 *    dead-letters attention cache.
 *  - `mesh_liveness_changed` (DOR-403) — the reconciler flipped an agent
 *    offline/online → refresh the mesh-status attention cache.
 *
 * NOT included, deliberately: session-list events (attention's stalled-session
 * and activity are both handled elsewhere — the list stream and no activity row),
 * `tunnel_status`/`commands_changed` (own dedicated sync hooks, no cache here).
 *
 * @internal Exported only so the unit test can assert the subscribed set matches.
 */
const EVENT_CACHE_INVALIDATIONS = {
  relay_message: ACTIVITY_KEYS,
  relay_flow: ACTIVITY_KEYS,
  relay_adapters_changed: ACTIVITY_KEYS,
  relay_bindings_changed: ACTIVITY_KEYS,
  extension_reloaded: ACTIVITY_KEYS,
  task_run_failed: [...ACTIVITY_KEYS, TASK_RUNS_KEY],
  relay_dead_letter: [DEAD_LETTERS_KEY],
  mesh_liveness_changed: [MESH_STATUS_KEY],
} as const satisfies Record<string, readonly QueryKey[]>;

/** The subscribed event names. @internal Exported for the unit test. */
const PULSE_FRESHNESS_EVENTS = Object.keys(
  EVENT_CACHE_INVALIDATIONS
) as (keyof typeof EVENT_CACHE_INVALIDATIONS & KnownEvent)[];

/**
 * Trailing-edge coalescing window (ms). A subscribed event schedules a flush this
 * far out; further events within the window fold into the same flush, so a burst
 * yields one invalidation pass, not one per event.
 */
const COALESCE_MS = 1_200;

/**
 * Subscribe the Pulse/dashboard activity and attention caches to their
 * correlated `/api/events` broadcasts, coalescing invalidations on a
 * trailing-edge debounce so a burst settles into a single flush.
 *
 * @param coalesceMs - Debounce window in milliseconds (default {@link COALESCE_MS});
 *   parameterised for deterministic testing.
 */
export function usePulseFreshness(coalesceMs: number = COALESCE_MS): void {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Query keys awaiting invalidation, de-duplicated by their serialized form so a
  // burst touching the same cache twice still flushes it once.
  const pendingRef = useRef(new Map<string, QueryKey>());

  const flush = useCallback(() => {
    timerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = new Map();
    // Invalidating an inactive query (e.g. the full /activity feed when off-route)
    // only marks it stale — it refetches on next mount, never wastefully now.
    for (const queryKey of pending.values()) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [queryClient]);

  // Trailing-edge debounce: each event pushes the flush out to `coalesceMs` from
  // now, so a burst settles into a single invalidation pass once the burst ends.
  const schedule = useCallback(
    (keys: readonly QueryKey[]) => {
      for (const key of keys) pendingRef.current.set(JSON.stringify(key), key);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, coalesceMs);
    },
    [flush, coalesceMs]
  );

  // Cancel any pending flush on unmount so a fired timer can't touch an unmounted
  // tree's query client.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  // One subscription per event name (fixed count → rules-of-hooks safe). Every
  // handler funnels into the same coalesced `schedule` with that event's caches.
  useEventSubscription('relay_message', () => schedule(EVENT_CACHE_INVALIDATIONS.relay_message));
  useEventSubscription('relay_flow', () => schedule(EVENT_CACHE_INVALIDATIONS.relay_flow));
  useEventSubscription('relay_adapters_changed', () =>
    schedule(EVENT_CACHE_INVALIDATIONS.relay_adapters_changed)
  );
  useEventSubscription('relay_bindings_changed', () =>
    schedule(EVENT_CACHE_INVALIDATIONS.relay_bindings_changed)
  );
  useEventSubscription('extension_reloaded', () =>
    schedule(EVENT_CACHE_INVALIDATIONS.extension_reloaded)
  );
  useEventSubscription('task_run_failed', () =>
    schedule(EVENT_CACHE_INVALIDATIONS.task_run_failed)
  );
  useEventSubscription('relay_dead_letter', () =>
    schedule(EVENT_CACHE_INVALIDATIONS.relay_dead_letter)
  );
  useEventSubscription('mesh_liveness_changed', () =>
    schedule(EVENT_CACHE_INVALIDATIONS.mesh_liveness_changed)
  );
}

export { EVENT_CACHE_INVALIDATIONS, PULSE_FRESHNESS_EVENTS };
