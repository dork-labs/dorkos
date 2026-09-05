/**
 * In-place URL rewrites that declare themselves to the navigation guard.
 *
 * Some URL writes do not go anywhere — opening Settings, switching a thread,
 * picking a runtime on the session you are already looking at. They rewrite the
 * search string but the cockpit stays put. The session-navigation guard
 * (`entities/session`) has to tell these apart from a real departure, because a
 * lookup in flight when the URL is rewritten in place must NOT be abandoned —
 * that would be a silent dead click (DOR-928, DOR-931).
 *
 * The guard used to guess from a hand-maintained list of param names, so any
 * param nobody had classified defaulted to "this is a departure" and produced a
 * dead click. This helper removes the guessing: an in-place rewrite goes through
 * `inPlaceNavigate`, which **stamps the navigation's own history state** with the
 * destination the rewrite hangs off. The guard reads that stamp instead of
 * matching names, so an unclassified param is impossible — the rewrite that
 * writes it is the thing that declares it in-place, by construction.
 *
 * Why carry the whole pre-rewrite destination rather than a bare `inPlace: true`
 * flag: a bare flag only records that the LAST hop was in-place, and the guard
 * is only consulted at await points, so it can miss a genuine navigation that
 * happened between the snapshot and an in-place rewrite (navigate to a channel,
 * then open Settings on it). Carrying the base destination forward means the
 * guard always compares against the place the in-place chain actually started,
 * so a genuine hop in the middle still reads as a departure.
 *
 * @module shared/model/use-in-place-navigate
 */
import { useCallback } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib/platform';

/**
 * The place an in-place rewrite hangs off — the location as it was before the
 * chain of in-place rewrites began. Whole pathname + search, so the guard can
 * derive the same destination key it would have derived before the rewrite.
 */
export interface InPlaceBaseDestination {
  /** Route path the chain started on, e.g. `/session`. */
  pathname: string;
  /** Search params the chain started with. */
  search: Record<string, unknown>;
}

/**
 * The slice of history state an in-place rewrite stamps onto its navigation.
 *
 * Present only on a location reached by {@link useInPlaceNavigate}; a genuine
 * navigation carries no `inPlaceBase`, because TanStack Router resets history
 * state to `{}` on any navigation that does not set it — which is exactly what
 * makes the declaration self-clearing without anyone remembering to clear it.
 */
export interface InPlaceNavigationState {
  /** The destination this in-place chain hangs off, or absent on a genuine hop. */
  inPlaceBase?: InPlaceBaseDestination;
}

/** A search-param updater, generic across routes (mirrors the navigate idiom). */
export type InPlaceSearchUpdater = (prev: Record<string, unknown>) => Record<string, unknown>;

/** Options for a single in-place rewrite. */
export interface InPlaceNavigateOptions {
  /** Optional route target, when the rewrite also names its own route. */
  to?: string;
  /** How to transform the current search params. */
  search: InPlaceSearchUpdater;
  /**
   * Whether to replace the current history entry rather than push a new one.
   * Orthogonal to in-place-ness: the onboarding stepper pushes entries so
   * back/forward walk its stages, yet each step is still an in-place rewrite.
   */
  replace?: boolean;
}

/** Perform an in-place URL rewrite that declares itself to the guard. */
export type InPlaceNavigate = (options: InPlaceNavigateOptions) => void;

/**
 * Navigate in place, declaring the rewrite to the session-navigation guard.
 *
 * Returns `null` when there is no router to rewrite — the Obsidian embed, which
 * mounts no `RouterProvider`, and any surface rendered outside one — exactly as
 * {@link useSafeNavigate} does. Callers fall back to their store path (or simply
 * do nothing) in that case. In the routed cockpit it returns a function that
 * performs the rewrite AND stamps the navigation's history state with the
 * destination it hangs off, so a lookup in flight is not mistaken for a
 * departure.
 *
 * The base is seeded from the current location on the first hop of a chain and
 * carried forward on later hops (`prev.inPlaceBase ?? current`), so a run of
 * in-place rewrites — open Settings, switch its tab, set a section — all report
 * the one destination the run started from. Any genuine navigation in between
 * resets history state, so the next in-place rewrite re-seeds from wherever the
 * cockpit actually is.
 *
 * @returns The in-place navigator, or `null` when there is no router.
 */
export function useInPlaceNavigate(): InPlaceNavigate | null {
  if (getPlatform().isEmbedded) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- conditional hook is safe: `isEmbedded` is fixed at bootstrap, so the hook order is stable for the app's lifetime (the dual-mode shape as useSafeNavigate).
  const navigate = useNavigate();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- same fixed-at-bootstrap invariant as above.
  const router = useRouter();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- same fixed-at-bootstrap invariant as above.
  const inPlaceNavigate = useCallback(
    ({ to, search, replace }: InPlaceNavigateOptions) => {
      // Unreachable while this function is the one the hook returned (that only
      // happens with a router), but keeps the isolated-render case honest.
      if (!router) return;
      // Read the pre-rewrite location lazily, at call time — this is the place a
      // fresh chain hangs off. Later hops keep the base a prior hop already set.
      const { pathname, search: currentSearch } = router.state.location;
      const stampBase = (prev: InPlaceNavigationState): InPlaceNavigationState => ({
        ...prev,
        inPlaceBase: prev.inPlaceBase ?? { pathname, search: currentSearch },
      });
      void navigate({
        ...(to !== undefined ? { to } : {}),
        // `as never`: the route-generic navigate types cannot see this call's
        // route, so neither the search nor the state updater can be checked
        // against a known schema. The state shape is precise at the boundary the
        // guard reads it ({@link InPlaceNavigationState}); TanStack's own history
        // state is an opaque bag here.
        search: search as never,
        replace,
        state: stampBase as never,
      });
    },
    [navigate, router]
  );
  return router ? inPlaceNavigate : null;
}
