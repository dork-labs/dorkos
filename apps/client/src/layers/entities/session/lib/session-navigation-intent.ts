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
 *    cooperate. It reads the router's own location, which every one of them
 *    moves by definition, and a lookup that comes back to a moved location stays
 *    quiet. Nothing to opt into and nothing for the next `navigate()` call
 *    anyone adds to remember.
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
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { useSessionListStore } from '../model/session-list-store';

/** Monotonic id of the most recent lookup-driven navigation started here. */
let latestLookup = 0;

/** The part of the router's location this module reads. */
export interface CockpitLocation {
  /** Route path, e.g. `/session` or `/channels`. */
  pathname: string;
  /** Parsed search params. Only `dir` and `session` are read. */
  search: Record<string, unknown>;
}

/**
 * Where the cockpit is pointed, as one comparable string.
 *
 * **Not the href.** Plenty of things rewrite the URL without going anywhere:
 * `?settings=` and `?tasks=` on open and close, the runtime chip, the thread
 * panel — which the code that writes it calls "reading, not navigating". Whole-
 * href equality reads every one of those as a departure and cancels an
 * in-flight lookup, so pressing ⌘, in the second after clicking an agent would
 * kill the click with nothing on screen to say why. A silent dead click is the
 * hardest failure for a person to report, so the comparison is narrowed to what
 * actually names a destination: the page, the agent, and the conversation.
 *
 * The session id is followed through the rekey map first. A brand-new session
 * is renamed to its canonical id in place on its first message
 * (`ChatPanel`'s replace), and that is the same conversation under a new name —
 * counting it as a move would be the same dead click by another route.
 *
 * @param location - The router's current location.
 * @returns A key equal for two locations that mean the same destination.
 */
export function sessionDestination(location: CockpitLocation): string {
  // Tolerates a search-less location rather than throwing. This runs inside a
  // guard whose whole job is to decide "do nothing", so a crash here would be
  // swallowed by the promise it lives in and read as a navigation that simply
  // never happened.
  const search = location.search ?? {};
  const read = (key: string): string =>
    typeof search[key] === 'string' ? (search[key] as string) : '';
  const session = read('session');
  const canonical = session ? (useSessionListStore.getState().rekeys[session] ?? session) : '';
  // NUL-joined: no path or id can contain it, so no two different destinations
  // can collide by concatenation.
  return [location.pathname, read('dir'), canonical].join('\u0000');
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
