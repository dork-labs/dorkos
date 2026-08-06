/**
 * Whether a navigation the cockpit started is still the one it wants.
 *
 * Deciding where a click leads became asynchronous once resolution learned to
 * ask the server (DOR-928), and an async decision can be overtaken. Two things
 * can overtake it, and they need different answers:
 *
 * 1. **Somebody else navigated while we were waiting.** Opening a channel, a
 *    thread, a Recent session, a forked session, an agent from the palette — the
 *    app has around twenty `navigate()` calls and not one of them has any reason
 *    to know an agent lookup is in flight. So this does NOT ask them to
 *    cooperate: it reads the router's own location, and a lookup that comes back
 *    to a different destination stays quiet.
 * 2. **We started a second lookup of our own.** Two agent clicks both begin at
 *    the same location, so the location cannot order them: whichever REQUEST
 *    answered first would win, which is not the agent the person asked for last.
 *    A counter orders those, and it is honest here because the only claimants
 *    are the three resolve-then-navigate paths in this entity.
 *
 * Both conditions must hold, and each covers what the other cannot.
 *
 * **In-place rewrites declare themselves; the guard does not guess.** Some URL
 * writes go nowhere — opening Settings, switching a thread, picking a runtime on
 * the session already on screen — and cancelling a lookup for one of those is a
 * silent dead click. The guard used to tell these apart with a hand-maintained
 * list of param names, so any param nobody had classified defaulted to "this is
 * a departure" and produced exactly that dead click (DOR-931). It no longer
 * keeps any list. An in-place rewrite goes through `useInPlaceNavigate`, which
 * stamps its history state with the destination it hangs off; {@link
 * sessionDestination} reads that stamp, so the rewrite reports the place it
 * started from and the guard sees no change. A param this file has never heard
 * of cannot break it, because the code that writes the param is the code that
 * declares it in-place.
 *
 * @module entities/session/lib/session-navigation-intent
 */
import type { InPlaceNavigationState } from '@/layers/shared/model';

/** Monotonic id of the most recent lookup-driven navigation started here. */
let latestLookup = 0;

/** The part of the router's location this module reads. */
export interface CockpitLocation {
  /** Route path, e.g. `/session` or `/channels`. */
  pathname: string;
  /** Parsed search params. */
  search: Record<string, unknown>;
  /**
   * History state — TanStack Router's opaque bag, narrowed to
   * {@link InPlaceNavigationState} on read. It carries an in-place rewrite's
   * declaration of where it hangs off, and is absent on a genuine navigation
   * (TanStack resets it to `{}`), so the declaration is self-clearing. Typed
   * `unknown` so the router's `ParsedLocation` assigns without a cast at the
   * ~five `() => router.state.location` call sites.
   */
  state?: unknown;
}

/** Read the in-place declaration a rewrite stamped onto a location, if any. */
function inPlaceBaseOf(location: CockpitLocation): InPlaceNavigationState['inPlaceBase'] {
  return (location.state as InPlaceNavigationState | undefined)?.inPlaceBase;
}

/**
 * Where the cockpit is pointed, as one comparable string.
 *
 * **Not the href, and not name-matched.** An in-place rewrite carries, in its
 * own history state, the destination it hangs off ({@link InPlaceNavigationState}
 * `inPlaceBase`, written by `useInPlaceNavigate`). When that stamp is present the
 * key is derived from it, so opening Settings — or setting any param, including
 * one this file has never seen — reports the place the rewrite started from and
 * reads as standing still. Without the stamp the key is derived from the live
 * location, so a genuine navigation to a different page or a different room reads
 * as a departure and cancels an in-flight lookup. A silent dead click is the
 * hardest failure for a person to report, so declared intent, not a param name,
 * is what decides.
 *
 * Params are sorted so the key does not depend on the order the router happened
 * to parse them in.
 *
 * @param location - The router's current location.
 * @returns A key equal for two locations that mean the same destination.
 */
export function sessionDestination(location: CockpitLocation): string {
  // An in-place rewrite reports the destination it hangs off; everything else
  // reports where it actually is.
  const base = inPlaceBaseOf(location) ?? location;
  const named = Object.entries(base.search)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort();
  // NUL-joined: no path or value can contain it, so no two different
  // destinations can collide by concatenation.
  return [base.pathname, ...named].join('\u0000');
}

/**
 * Begin a navigation whose destination is not known yet.
 *
 * Call this at the moment of the gesture — the click, not the answer — so the
 * ordering reflects what the person did rather than what the network did.
 *
 * @param readLocation - Reads the router's current location, e.g.
 *   `() => router.state.location`. Read again on each check, so any navigation
 *   by anyone is visible without that caller knowing this exists.
 * @returns A predicate answering whether this navigation is still wanted. Check
 *   it after every `await` and before acting; `false` means the cockpit has
 *   moved on, and the right move is to do nothing at all — not even to explain
 *   yourself, since the person is somewhere else now.
 */
export function beginSessionNavigation(readLocation: () => CockpitLocation): () => boolean {
  const startedAt = sessionDestination(readLocation());
  const mine = ++latestLookup;
  return () => mine === latestLookup && sessionDestination(readLocation()) === startedAt;
}
