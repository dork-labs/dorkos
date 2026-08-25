/**
 * The one place ⌘K is allowed to point at a surface it does not own (P3 AC-6).
 *
 * ⌘K finds things, not words: it searches what agents, conversations, channels
 * and actions are CALLED, and never what was said inside them. Searching what
 * was said is a second, separate surface — the Slack ⌘K/⌘F split this product
 * chose on purpose (`specs/rooms` §13.2, `specs/message-search` §8) — and the
 * palette's job at that boundary is one honest row: *Search messages for "x"…*,
 * which hands off and does nothing else. Nothing in this feature's NAVIGATION
 * half ever runs a content search, and
 * `__tests__/palette-ranks-names-not-content.test.ts` reads every line that
 * ships to keep it that way.
 *
 * **The surface exists now, and it is a dialog rather than a route.** This
 * module used to gate the row on `APP_ROUTE_PATHS` gaining a `/search` path,
 * and it named its own failure mode: *"If it ships as a panel or a modal
 * instead … no path is ever added, the check keeps returning `null`, the row
 * never appears, and no test goes red."* That is exactly what happened, and
 * this is the one line it said would need moving. `MessageSearchDialog` is a
 * sibling of the palette, opened from the app store, so there is no path to
 * ask about — the row is drawn whenever there is something to search FOR.
 *
 * **Why a dialog and not a page.** A search here is a way to get somewhere
 * else: you ask "where did we talk about X", you land in the room, and the
 * search is over. A route would leave a results page sitting in history behind
 * every destination, and would rebuild the keyboard model cmdk already gives
 * this feature for nothing.
 *
 * @module features/command-palette/model/search-surface
 */

/**
 * The words to hand across, or `null` when there are none.
 *
 * One refusal, and it is not about the surface any more: a row reading *Search
 * messages for ""…* offers to search for nothing, and the zero-query palette is
 * a command center rather than a search result anyway.
 *
 * **The hand-off drops the scope, deliberately.** With an `@Frontend App` chip
 * up, this still hands off a GLOBAL search: the message-search box has no scope
 * vocabulary — it searches everything the caller may read, with no notion of
 * "inside this agent" — so there is nothing to carry the chip across in.
 * Widening beats inventing a filter the far side would ignore, and beats hiding
 * the row under a chip, which would make ⌘K's last line come and go for reasons
 * a person cannot see. The row SAYS so instead: under a chip it reads "Search
 * all messages for …", which is the copy obligation this module left behind for
 * whoever shipped the surface, now discharged in `PaletteSearchHandoffRow`.
 *
 * @param term - What was typed, after any prefix — the words a person would
 *   want looked for, not the `#`/`@`/`>` they used to narrow the list. Under a
 *   chip there are no prefixes (`usePaletteSearch`), so a `#` there is a
 *   character in what they typed and travels verbatim.
 * @returns The trimmed words, or `null` when nothing was typed.
 */
export function searchHandoffTerm(term: string): string | null {
  const trimmed = term.trim();
  return trimmed.length === 0 ? null : trimmed;
}
