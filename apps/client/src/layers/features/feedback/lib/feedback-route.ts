/**
 * Build the `route` a feedback submission records: the page address, with an
 * ALLOWLISTED query string (DOR-1960).
 *
 * ## Why this is an allowlist and not a truncation
 *
 * `/session` on its own does not say which conversation broke, so the query
 * string is worth carrying. But DorkOS URLs are not all identifiers. The
 * `/session` route writes the resolved **absolute working directory** into
 * `?dir=` unconditionally (`router.tsx`, DOR-1836), and carries the user's
 * **typed prompt** in `?prompt=` and `?message=` on a new conversation. The
 * roster and marketplace both put their **search box** in `?q=`, and the legacy
 * agent dialog keeps a filesystem path in `?agentPath=`.
 *
 * A feedback `route` is forwarded to the site, stored in Neon, folded into a
 * Linear issue, and sent as a PostHog property — and it rides OUTSIDE the
 * Diagnostics consent toggle, because a coarse route always has. So a
 * pass-everything query string would ship `/Users/<name>/<client>/<project>`
 * and whatever the person last typed to an agent, every time anyone reported
 * anything. A denylist would be the wrong shape for that: it fails open, so
 * every future search param added to any route is a leak until someone
 * remembers this file.
 *
 * Hence {@link ROUTE_QUERY_ALLOWLIST} — closed, enumerated, and matched against
 * the real `validateSearch` schemas in `router.tsx`. Everything else is dropped,
 * including params that look harmless today.
 *
 * ## Why identifiers are serialized first
 *
 * `URLSearchParams` preserves the URL's own order, and on a real `/session` URL
 * `dir` and `prompt` are written BEFORE `session`. Serializing in arrival order
 * therefore spent the 256-character budget on the params being dropped, and
 * could push the session id — the one value this change exists to capture — off
 * the end. The allowlist is ordered "what you were looking at" first, "where on
 * the page" second, and a param is appended only when it fits WHOLE, so the
 * result never ends mid-key, mid-value, or mid-percent-escape.
 *
 * @module features/feedback/lib/feedback-route
 */
import { MAX_FEEDBACK_ROUTE_LEN } from '@dorkos/shared/telemetry-events';

/**
 * The query params a feedback `route` may carry, in serialization order.
 *
 * Every entry is an opaque identifier or a closed enum drawn from the route
 * search schemas in `apps/client/src/router.tsx` and
 * `layers/shared/model/dialog-search-schema.ts`. Ordered deliberately:
 *
 * **Identifiers — which thing you were looking at (first claim on the budget):**
 * - `session` — session id (`sessionSearchSchema`)
 * - `id` — channel id (`channelsSearchSchema`)
 * - `thread` — thread id (home, channels)
 * - `entry` — room entry sequence number (home, channels)
 * - `itemId` — home attention-item id
 * - `agent` — agent id (team topology panel, legacy agent dialog)
 * - `profile` — roster id whose profile is open
 * - `continuedFrom` — the session this one continued from
 * - `pkg` — marketplace package name
 *
 * **View state — where on the page you were:**
 * - `view` — team view / marketplace browse-vs-installed (both closed enums)
 * - `region` — connections region: `messaging` | `accounts`
 * - `detail` — home detail pane: `dead-letter` | `failed-run` | `offline-agent`
 * - `panel` — which shell-level right panel is open
 *
 * **Deliberately absent, and why** — these exist in the same URLs and must
 * never ride along: `dir` and `agentPath` (absolute filesystem paths),
 * `prompt`, `message`, `seed` (text the user typed to an agent), `q` (the
 * roster and marketplace search boxes), `owner`, `actorId`, `categories`,
 * `category`, `source`, `since`, `sort`, `settings`, `settingsSection`,
 * `hubTab`, `profilePage`, `review`, `flow`, `request`, `runtime`, `kind`,
 * `group`, `send`, `tasks`, `relay`. Anything not listed above is dropped
 * whether or not it appears in this paragraph.
 */
export const ROUTE_QUERY_ALLOWLIST = [
  'session',
  'id',
  'thread',
  'entry',
  'itemId',
  'agent',
  'profile',
  'continuedFrom',
  'pkg',
  'view',
  'region',
  'detail',
  'panel',
] as const;

/**
 * Build the `route` for a feedback submission.
 *
 * @param pathname - The active route path, e.g. `/session`.
 * @param searchStr - The serialized query string, e.g. `?dir=/Users/x&session=a`
 *   (leading `?` optional). Anything outside {@link ROUTE_QUERY_ALLOWLIST} is
 *   dropped.
 * @returns `pathname`, plus the allowlisted params that fit whole within
 *   `MAX_FEEDBACK_ROUTE_LEN`. Never exceeds that cap, and never truncates a
 *   param part-way.
 */
export function buildFeedbackRoute(pathname: string, searchStr: string): string {
  if (pathname.length >= MAX_FEEDBACK_ROUTE_LEN) {
    return pathname.slice(0, MAX_FEEDBACK_ROUTE_LEN);
  }

  const incoming = new URLSearchParams(searchStr);
  let query = '';

  for (const key of ROUTE_QUERY_ALLOWLIST) {
    for (const value of incoming.getAll(key)) {
      // Re-encode through URLSearchParams so the kept value is escaped the same
      // way it arrived, and measure the WHOLE `key=value` piece before taking
      // it — a piece that does not fit is skipped entirely rather than sliced,
      // which is what keeps a percent-escape from being cut in half.
      const piece = new URLSearchParams([[key, value]]).toString();
      const candidate = query ? `${query}&${piece}` : piece;
      // +1 for the `?`.
      if (pathname.length + 1 + candidate.length <= MAX_FEEDBACK_ROUTE_LEN) {
        query = candidate;
      }
    }
  }

  return query ? `${pathname}?${query}` : pathname;
}
