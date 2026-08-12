/**
 * The one place ⌘K is allowed to point at a surface it does not own (P3 AC-6).
 *
 * ⌘K finds things, not words: it searches what agents, conversations, channels
 * and actions are CALLED, and never what was said inside them. Searching what
 * was said is a second, separate surface — the Slack ⌘K/⌘F split this product
 * chose on purpose (`specs/rooms` §13.2, `specs/message-search` §8) — and the
 * palette's job at that boundary is one honest row: *Search messages for "x"…*,
 * which hands off and does nothing else. Nothing in this feature ever runs a
 * content search, and `__tests__/no-message-search.test.ts` reads every line
 * that ships to keep it that way.
 *
 * **The row exists only when the surface does.** DOR-672 has not shipped, so
 * today the palette draws no such row at all — not a disabled one, not a
 * "coming soon", not a commented-out block. A row that leads nowhere teaches a
 * person that ⌘K's last line is a dead end, which is a worse lesson than never
 * having offered it.
 *
 * **What "the surface exists" is measured against.** {@link APP_ROUTE_PATHS} —
 * the cockpit's own list of the paths its router serves, which
 * `app-route-paths.test.ts` fails the build over if it ever drifts from the
 * real route tree. So the check is not a flag somebody has to remember to flip:
 * whoever builds the search page adds its route, the list gains a path, and
 * this row appears by itself.
 *
 * @module features/command-palette/model/search-surface
 */
import { APP_ROUTE_PATHS } from '@/layers/shared/lib';

/**
 * Where the surface that searches what was said will live.
 *
 * The single hinge in this module: the day a search page is served at this
 * path, the hand-off row starts being drawn and nothing else has to change. If
 * that surface lands somewhere else, this constant is the one line to move.
 *
 * **The failure mode is silence, and it is worth naming.** This assumes DOR-672
 * ships message search as a ROUTE. If it ships as a panel or a modal instead —
 * this cockpit deep-links several of those through search params rather than
 * paths — no path is ever added, the check keeps returning `null`, the row
 * never appears, and no test goes red, because "absent" is exactly what every
 * assertion here expects today. Nothing can detect that from this side; whoever
 * builds the surface has to come back to this constant. It is one line either
 * way: a different path, or a different question asked of a different registry.
 */
export const SEARCH_SURFACE_PATH = '/search';

/** How the query travels to it — the same name its route already answers to. */
const QUERY_PARAM = 'q';

/**
 * Where to hand `term` off to, or `null` when this cockpit has nowhere to send
 * it.
 *
 * Two ways it is `null`, and they are different refusals. **No surface**: the
 * router serves no such path, so there is nothing to offer. **Nothing typed**:
 * a row reading *Search messages for ""…* offers to search for nothing, and the
 * zero-query palette is a command center rather than a search result anyway.
 *
 * **The hand-off drops the scope, deliberately.** With an `@Frontend App` chip
 * up, this still produces a GLOBAL search href: the message-search surface has
 * no scope vocabulary — its route contract is `q` and an optional source id,
 * with no notion of "inside this agent" — so there is nothing to carry the chip
 * across in. Widening beats inventing a parameter the far side would ignore,
 * and beats hiding the row under a chip, which would make ⌘K's last line come
 * and go for reasons a person cannot see.
 *
 * **It leaves a copy obligation for whoever ships that surface.** Under a chip
 * the row must read "Search **all** messages for …", or it reads as searching
 * inside the scope and quietly does not. The row says "Search messages for …"
 * today, which is true only because a chip and this row cannot both be true
 * yet — the row is unreachable until DOR-672 lands.
 *
 * @param term - What was typed, after any prefix — the words a person would
 *   want looked for, not the `#`/`@`/`>` they used to narrow the list. Under a
 *   chip there are no prefixes (`usePaletteSearch`), so a `#` there is a
 *   character in what they typed and travels verbatim.
 * @param routes - The paths this cockpit serves. Defaults to the real registry;
 *   a caller passes its own only to prove this check discriminates, which a
 *   check that can never return an href would not.
 */
export function searchHandoffHref(
  term: string,
  routes: readonly string[] = APP_ROUTE_PATHS
): string | null {
  if (!routes.includes(SEARCH_SURFACE_PATH)) return null;
  const trimmed = term.trim();
  if (trimmed.length === 0) return null;
  return `${SEARCH_SURFACE_PATH}?${QUERY_PARAM}=${encodeURIComponent(trimmed)}`;
}
