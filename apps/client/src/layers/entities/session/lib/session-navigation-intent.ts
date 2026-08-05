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

/** Monotonic id of the most recent lookup-driven navigation started here. */
let latestLookup = 0;

/**
 * Begin a navigation whose destination is not known yet.
 *
 * Call this at the moment of the gesture — the click, not the answer — so the
 * ordering reflects what the person did rather than what the network did.
 *
 * @param readLocation - Reads the router's current location key, e.g.
 *   `() => router.state.location.href`. Read again on each check, so any
 *   navigation by anyone is visible without that caller knowing this exists.
 * @returns A predicate answering whether this navigation is still wanted. Check
 *   it after every `await` and before acting; `false` means the cockpit has
 *   moved on, and the right move is to do nothing at all — not even to explain
 *   yourself, since the person is somewhere else now.
 */
export function beginSessionNavigation(readLocation: () => string): () => boolean {
  const startedAt = readLocation();
  const mine = ++latestLookup;
  return () => mine === latestLookup && readLocation() === startedAt;
}
