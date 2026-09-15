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
   * DEFERS the pending keys — it never drops them: they stay pending and the
   * flush is re-armed a full window out, so it lands as soon as the veto lifts.
   *
   * **Deferring rather than dropping is the whole contract, and the first cut
   * of this file got it wrong.** The caller is the hook that stands down while
   * its own window has a write in flight, on the reasoning that the mutation
   * will invalidate on settle anyway. That reasoning does not hold for every
   * writer: three config mutations invalidate on `onSuccess` ALONE
   * (`useUpdateConfig`, `useAgentContextConfig`, `useMeshScanRoots`), so a
   * REFUSED write re-reads nothing. Window A's refused PATCH overlapping a
   * write in window B would then swallow B's broadcast and leave A showing a
   * value nothing will ever correct. Held keys cost one extra timer; dropped
   * keys cost a cache that is silently wrong.
   *
   * Omitted means always flush.
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
  // Same reason as above, and additionally because `flush` re-arms itself on a
  // veto: reading the window through a ref keeps `flush` out of `schedule`'s
  // dependency list when a caller re-renders with a different one.
  const coalesceMsRef = useRef(coalesceMs);
  useEffect(() => {
    shouldFlushRef.current = shouldFlush;
    coalesceMsRef.current = coalesceMs;
  });

  // A NAMED function expression, so the veto branch can re-arm by referring to
  // the function itself rather than to the `const` it is being assigned to —
  // which would be a use-before-declaration.
  const flush = useCallback(
    function flushPending(): void {
      timerRef.current = null;
      // The veto is asked BEFORE anything is taken off the pending map, so a
      // refusal leaves the keys exactly where they were and simply re-arms. The
      // retry is bounded by the thing being waited on: a mutation settles, and an
      // unmount clears the timer.
      if (shouldFlushRef.current && !shouldFlushRef.current()) {
        timerRef.current = setTimeout(flushPending, coalesceMsRef.current);
        return;
      }
      const pending = pendingRef.current;
      pendingRef.current = new Map();
      for (const target of pending.values()) {
        void queryClient.invalidateQueries(
          target.exact ? { queryKey: target.queryKey, exact: true } : { queryKey: target.queryKey }
        );
      }
    },
    [queryClient]
  );

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
