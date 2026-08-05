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
 *    to a different destination stays quiet. Nothing to opt into and nothing for
 *    the next `navigate()` call anyone adds to remember — an unfamiliar param
 *    counts as a departure until somebody says otherwise, which is the safe way
 *    round.
 * 2. **We started a second lookup of our own.** Two agent clicks both begin at
 *    the same location, so the location cannot order them: whichever REQUEST
 *    answered first would win, which is not the agent the person asked for last.
 *    A counter orders those, and it is honest here because the only claimants
 *    are the three resolve-then-navigate paths in this entity.
 *
 * Both conditions must hold, and each covers what the other cannot. An earlier
 * version claimed only the counter, and asked every surface in the app to bump
 * it — a discipline dressed as a mechanism, which read as fixed while three
 * navigations in the same file had never opted in.
 *
 * @module entities/session/lib/session-navigation-intent
 */
import { DIALOG_SEARCH_PARAM_NAMES } from '@/layers/shared/model';

/** Monotonic id of the most recent lookup-driven navigation started here. */
let latestLookup = 0;

/**
 * Search params that rewrite the URL without going anywhere.
 *
 * A DENYLIST, not an allowlist, and that direction is the point: a param nobody
 * has classified defaults to "this is a departure", which is the harmless way to
 * be wrong. Listing destination params instead meant every page whose identity
 * lives in a param the session URL never carries — `/channels?id=`,
 * `/agents?agent=`, `/marketplace?…` — collapsed onto a single destination, so
 * moving between two rooms read as standing still.
 *
 * The dialog params come from the one module that owns them, so a dialog growing
 * a param cannot silently start reading as a navigation.
 */
let inPlaceParams: ReadonlySet<string> | null = null;

/**
 * Is this a search param that rewrites the URL without going anywhere?
 *
 * A DENYLIST, not an allowlist, and that direction is the point: a param nobody
 * has classified defaults to "this is a departure", which is the harmless way to
 * be wrong. Listing destination params instead meant every page whose identity
 * lives in a param the session URL never carries — `/channels?id=`,
 * `/agents?agent=`, `/marketplace?…` — collapsed onto a single destination, so
 * moving between two rooms read as standing still.
 *
 * **Built on first call, not at module load.** The dialog names come from a
 * barrel that is not guaranteed to be initialised when this module is
 * evaluated, and a top-level `new Set([...names])` threw at import time for
 * every suite that reached this file first. Deferring to first use means every
 * module is ready by then. Do not "simplify" it back to a top-level constant.
 */
function isInPlaceParam(key: string): boolean {
  inPlaceParams ??= new Set([
    // `?settings=`, `?settingsSection=`, `?tasks=` — on open AND on close.
    // Taken from the module that owns them, so a dialog growing a param cannot
    // silently start reading as a navigation.
    ...DIALOG_SEARCH_PARAM_NAMES,
    // The thread panel, whose own sync calls opening and closing it "reading,
    // not navigating".
    'thread',
    // The first-run overlay, which rides above whatever route is active.
    'onboarding',
    // The runtime chip, which rewrites `?runtime=` in place on the session you
    // are already looking at.
    'runtime',
  ]);
  return inPlaceParams.has(key);
}

/** The part of the router's location this module reads. */
export interface CockpitLocation {
  /** Route path, e.g. `/session` or `/channels`. */
  pathname: string;
  /** Parsed search params. */
  search: Record<string, unknown>;
}

/**
 * Where the cockpit is pointed, as one comparable string.
 *
 * **Not the href.** Plenty of things rewrite the URL without going anywhere —
 * see {@link isInPlaceParam}. Whole-href equality reads every one of
 * those as a departure and cancels an in-flight lookup, so pressing ⌘, in the
 * second after clicking an agent would kill the click with nothing on screen to
 * say why. A silent dead click is the hardest failure for a person to report.
 *
 * Everything else counts. Params are sorted so the key does not depend on the
 * order the router happened to parse them in.
 *
 * @param location - The router's current location.
 * @returns A key equal for two locations that mean the same destination.
 */
export function sessionDestination(location: CockpitLocation): string {
  const named = Object.entries(location.search)
    .filter(([key, value]) => value !== undefined && !isInPlaceParam(key))
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort();
  // NUL-joined: no path or value can contain it, so no two different
  // destinations can collide by concatenation.
  return [location.pathname, ...named].join('\u0000');
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
