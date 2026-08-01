/**
 * Keep the cached detail row for a session as fresh as the list row beside it,
 * without ever letting an older answer overwrite a newer one.
 *
 * ## The two caches, and why one used to lie
 *
 * A session is cached twice: once as a row in its working directory's list, and
 * once as its own detail entry under `sessionKeys.detail`. Surfaces read both —
 * a sidebar row reads the detail entry first and its own list row second,
 * because the detail entry is the only place a change the person just made
 * appears before the list hears about it.
 *
 * The detail entry had exactly two writers: its own fetch, and the answer to a
 * settings PATCH. Neither fires for a session the person is not inside. A row
 * that reads the entry keeps a live observer on it while never being allowed to
 * fetch, so the entry is never collected and never refreshed — it stays frozen
 * at whatever the server said the last time somebody opened that session, and
 * outranks a list row that arrived seconds ago. A session switched to a
 * permissions-bypassing mode from another window therefore lost its warning icon
 * in the rail, which inverts the property that icon exists for (DOR-496).
 *
 * So: every server-authoritative row that lands in this client refreshes the
 * cached detail entry for that session too. The server already guarantees the
 * answer is the same one the detail endpoint would give — `GET /api/sessions`,
 * `GET /api/sessions/:id`, `GET /api/sessions/recent` and the `session_upserted`
 * fan-out all pass through one settings overlay for exactly that reason
 * (DOR-463).
 *
 * ## Arrival order is not freshness
 *
 * The naive version of this — write whatever arrives — reintroduces the same
 * defect through the opposite door, and the first version of this module did.
 * A list fetch already in flight when the person turns the permission dial was
 * built server-side BEFORE the PATCH persisted. It lands after the PATCH answer
 * has written the detail entry and after the convergence effect has dropped the
 * optimistic override that would have outranked it, so it silently reverts the
 * session to the mode it held a moment ago — the rail going quiet about a bypass
 * the person just switched on. That interleaving is ordinary, not exotic:
 * `refetchOnWindowFocus` against a 30s `staleTime`, the SSE reconnect broom, and
 * a Claude account switch each put a list fetch in flight at an arbitrary moment.
 *
 * The property this module owes its readers is therefore stronger than "keep the
 * detail entry current":
 *
 * > **A value confirmed later never loses to data fetched earlier.**
 *
 * Which needs each answer to carry WHEN it was true, not when it happened to
 * arrive. Every caller passes the instant it started listening for this answer,
 * and this module both compares against that instant and stamps it onto the
 * entry it writes. So the timestamp on a cached detail row always means "the
 * server said so as of this moment", whichever writer put it there, and
 * comparing two of them is meaningful.
 *
 * `Session.updatedAt` cannot do this job: it tracks the transcript, so a row
 * carrying an out-of-date permission mode can hold the newer `updatedAt` of the
 * two.
 *
 * ## Why the entry is stamped, and not just compared
 *
 * The write carries `observedAt` too, so a row this module wrote is dated by
 * when its data was true rather than by when the copy happened. Without that the
 * guard is only correct for adjacent pairs and inverts on the next one out: an
 * answer whose fetch started at t0 and landed at t2 would date the entry t2, and
 * a DIFFERENT source whose fetch started at t1 — later than t0, so genuinely
 * newer — would be skipped for arriving after t2. Two list answers of the same
 * key cannot interleave that way, because TanStack dedupes them; the recent-
 * sessions fetch and the session-list fetch are separate queries and can.
 *
 * ## What this does NOT do: keep the detail endpoint in the loop
 *
 * An accepted write still moves the entry's staleness clock forward — to the
 * answer's own age rather than to "now", which is one round trip earlier, but
 * forward. List answers arrive on every window focus, so an open session's
 * detail query can go a long time without its 30s `staleTime` elapsing, and the
 * detail endpoint is consulted rarely while a rail is live.
 *
 * That is honest rather than harmful, and it rests on an invariant worth naming:
 * **all three runtimes build the detail row and the list row from one builder**
 * (`extractSessionMeta` for claude-code, the same registry object for codex,
 * `getSession` being a `listSessions` entry for opencode), so an accepted write
 * is a COMPLETE refresh and dating the entry by it tells the truth. The merge
 * below is belt-and-braces for the day that stops holding. If a field ever
 * appears on the detail row that the list row omits, the merge will preserve it
 * — but nothing will refresh it, and it will age silently. That is the DOR-496
 * freeze one field-set over, and the point at which this module has to start
 * refreshing from the detail endpoint rather than around it.
 *
 * ## The window this does not close
 *
 * A `session_upserted` frame is serialized by the server and read by the client
 * one network hop later, and nothing on the wire says when it was serialized. So
 * its caller passes the instant it arrived, which is the earliest moment the
 * client can observe, and a frame serialized just BEFORE a PATCH persisted but
 * delivered just after it can still win. The event carries the settings overlay
 * applied at serialization time, so this is only reachable inside the PATCH's own
 * response tail.
 *
 * When it is reached, the consequence is the full one, not a softened version:
 * arrival time IS "now", so the accepted write dates the entry now, and the row
 * sits wrong for the whole `staleTime` — and a session nobody is inside has no
 * observer that may fetch, so nothing ends it until another answer happens to
 * cover that session. Scoping the window is the honest claim here; self-healing
 * is not. Closing it needs a server-side emit timestamp on the event.
 *
 * ## Why not simply prefer the list row
 *
 * Because the detail entry is genuinely the fresher of the two for the session
 * the person is inside: a settings PATCH writes it directly, and the list row
 * does not change until the runtime's own watcher notices. Demoting it would
 * trade the original defect for the mirror image described above, permanently
 * rather than on a race. Fixing which value is stale is the only change that
 * leaves both readings correct.
 *
 * @module entities/session/lib/sync-session-detail-cache
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import { sessionKeys } from '../api/query-keys';

/**
 * Whether a cached value under the detail prefix is a session row.
 *
 * `sessionKeys.detailRoot` is walked below, which makes this module one of the
 * things holding up the invariant `query-keys.ts` states for that prefix. A bare
 * cast would turn a future entry of another shape into a runtime throw inside a
 * cache sweep — exactly how the sibling sweep over `listRoot` broke (DOR-497).
 */
function isSessionRow(value: unknown): value is Session {
  return typeof value === 'object' && value !== null && typeof (value as Session).id === 'string';
}

/**
 * Merge fresh server rows into every cached detail entry they cover, skipping
 * any entry that already holds a later answer.
 *
 * Merged rather than replaced, and scoped to entries that already exist: the
 * detail endpoint may answer with fields the list does not carry, and a session
 * nobody has opened has no entry to keep current. Entries for sessions absent
 * from `sessions` are left untouched, so an unrelated row is never marked fresh
 * by a refresh that passed it by.
 *
 * @param queryClient - The client holding both caches.
 * @param sessions - Rows straight from the server, in any order.
 * @param observedAt - When the caller started listening for this answer:
 *   `Date.now()` taken immediately before the request, or the moment an event
 *   arrived. It must be a lower bound on when the server built these rows —
 *   passing the time they finished ARRIVING would defeat the guard, since that
 *   is always later than whatever it is being compared against.
 */
export function syncSessionDetailCache(
  queryClient: QueryClient,
  sessions: readonly Session[],
  observedAt: number
): void {
  if (sessions.length === 0) return;
  const fresh = new Map(sessions.map((session) => [session.id, session]));

  for (const query of queryClient.getQueryCache().findAll({ queryKey: sessionKeys.detailRoot })) {
    const cached = query.state.data;
    if (!isSessionRow(cached)) continue;
    const incoming = fresh.get(cached.id);
    if (incoming === undefined) continue;
    // Ties go to the entry already there, and that is symmetric: a tie discards
    // the later answer whichever way it points, so it can drop one that would
    // RAISE a warning just as readily as one that would lower it. The incumbent
    // wins anyway, because the alternative on an unorderable pair is "whatever
    // arrived last" — the exact rule this module exists to stop trusting.
    //
    // Reaching it needs two answers about ONE session stamped in the same
    // millisecond. The claude-code watcher, which produces nearly all of these
    // frames, debounces per slug directory (`SESSION_LIST_DEBOUNCE_MS`, 250ms)
    // and drops rows whose metadata is unchanged (`sessionMetaEqual`), so its
    // frames for a single session land a quarter-second apart.
    if (query.state.dataUpdatedAt >= observedAt) continue;
    queryClient.setQueryData<Session>(
      query.queryKey,
      { ...cached, ...incoming },
      { updatedAt: observedAt }
    );
  }
}
