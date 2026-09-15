/**
 * Turn a burst of `/api/events` broadcasts into one query invalidation pass.
 *
 * Every `*Sync` hook on the global stream has the same problem: the server can
 * emit the same news several times in a second — a drag gesture writing the
 * sidebar four times, a scan registering six agents, a reconciler pass adopting
 * a folder of them — and invalidating on each one stampedes the queries for a
 * result the last event already implies. So each event pushes a trailing-edge
 * flush out to `coalesceMs` from now, and the keys pile up in a map keyed by
 * their serialized form, so a burst touching one cache twice still refetches it
 * once.
 *
 * Invalidating an INACTIVE query only marks it stale — it refetches on its next
 * mount, never wastefully now — so a hook may name caches whose surface is
 * off-route without paying for them.
 *
 * @module shared/model/query/use-coalesced-invalidation
 */
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * One cache to refresh.
 *
 * `exact` is here rather than left to the caller because TanStack Query matches
 * query keys by PREFIX unless told otherwise, and several of the keys these
 * hooks name are prefixes of something else — `['team']` is a prefix of one
 * member's rooms, `['tasks']` of a session's streamed todo list. A hook that
 * wanted the one entry and got the family would reset a live list mid-turn.
 */
export interface QueryInvalidation {
  /** The key to invalidate. */
  queryKey: QueryKey;
  /** Match this key alone rather than everything under it. */
  exact?: boolean;
}

/** Knobs for {@link useCoalescedInvalidation}. */
export interface CoalescedInvalidationOptions {
  /**
   * Trailing-edge window in milliseconds. Long enough that a human gesture
   * settles inside one flush, short enough that the change still feels
   * immediate.
   */
  coalesceMs: number;
  /**
   * Asked once per flush, immediately before invalidating. Returning `false`
   * DROPS the pending keys rather than deferring them — for the caller whose
   * own mutation is mid-write and will invalidate on settle anyway, where a
   * refetch now would hand the cache back a value the write has already moved
   * past. Omitted means always flush.
   */
  shouldFlush?: () => boolean;
}

/**
 * Get a `schedule(targets)` that coalesces query invalidations on a trailing edge.
 *
 * Any pending flush is cancelled on unmount, so a fired timer can never touch
 * an unmounted tree's query client.
 *
 * @param options - The window, and an optional per-flush veto.
 * @returns `schedule` — call it with the caches this event can change.
 */
export function useCoalescedInvalidation(
  options: CoalescedInvalidationOptions
): (targets: readonly QueryInvalidation[]) => void {
  const { coalesceMs, shouldFlush } = options;
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Targets awaiting invalidation, de-duplicated by their serialized form. */
  const pendingRef = useRef(new Map<string, QueryInvalidation>());
  // Held in a ref so a caller may pass an inline closure without the schedule
  // identity changing on every render. Written in an effect rather than during
  // render — a ref assigned while rendering is a `react-hooks/refs` violation,
  // and effects run before any event could reach the handler that schedules.
  const shouldFlushRef = useRef(shouldFlush);
  useEffect(() => {
    shouldFlushRef.current = shouldFlush;
  });

  const flush = useCallback(() => {
    timerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = new Map();
    if (shouldFlushRef.current && !shouldFlushRef.current()) return;
    for (const target of pending.values()) {
      void queryClient.invalidateQueries(
        target.exact ? { queryKey: target.queryKey, exact: true } : { queryKey: target.queryKey }
      );
    }
  }, [queryClient]);

  const schedule = useCallback(
    (targets: readonly QueryInvalidation[]) => {
      for (const target of targets) {
        pendingRef.current.set(JSON.stringify([target.queryKey, target.exact ?? false]), target);
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, coalesceMs);
    },
    [flush, coalesceMs]
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  return schedule;
}
