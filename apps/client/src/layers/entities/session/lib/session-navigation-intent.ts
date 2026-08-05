/**
 * Which "take me there" is the current one.
 *
 * Deciding where a click leads became asynchronous once resolution learned to
 * ask the server (DOR-928), and an async decision can be overtaken. Two clicks
 * are two races, and the URL was going to whichever REQUEST answered last —
 * which is not the one the person asked for. It does not even need two clicks:
 * a Recent-session row navigates immediately, so an agent lookup still in
 * flight would land afterwards and yank you off the conversation you had just
 * opened.
 *
 * So every surface that decides where the cockpit goes claims here first, and
 * an earlier claim that comes back late finds it is no longer current and stays
 * quiet. **Synchronous navigations claim too** — that is what makes them able to
 * cancel a slow lookup instead of being trampled by it.
 *
 * One counter for the whole app rather than one per surface, because there is
 * one address bar: a per-surface token cannot see the sibling surface that
 * navigated while it was waiting, which is exactly the second case above.
 *
 * @module entities/session/lib/session-navigation-intent
 */

/** Monotonic id of the most recent navigation intent anyone has claimed. */
let latestIntent = 0;

/**
 * Claim the cockpit's next navigation.
 *
 * Call this at the moment of the gesture — the click, not the answer — so the
 * claims are ordered by what the person did rather than by what the network did.
 *
 * @returns A predicate answering whether this claim is still the current one.
 *   Check it after every `await` and before navigating; `false` means someone
 *   asked to go somewhere else in the meantime, and the right move is to do
 *   nothing at all.
 */
export function claimSessionNavigation(): () => boolean {
  const mine = ++latestIntent;
  return () => mine === latestIntent;
}
