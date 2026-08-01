/**
 * Keep the cached detail row for a session as fresh as the list row beside it.
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
 * cached detail entry for that session too. There are exactly two places fresh
 * rows arrive — the `/api/events` bridge and the session-list fetch — and both
 * call this. The server already guarantees the answer is the same one the detail
 * endpoint would give: `GET /api/sessions`, `GET /api/sessions/:id` and the
 * `session_upserted` fan-out all pass through one settings overlay for exactly
 * that reason (DOR-463).
 *
 * ## Why not simply prefer the list row
 *
 * Because the detail entry is genuinely the fresher of the two for the session
 * the person is inside: a settings PATCH writes it directly, and the list row
 * does not change until the runtime's own watcher notices. Demoting it would
 * trade this defect for its mirror image — the rail going quiet about a bypass
 * the person had just switched on. Fixing which value is stale is the only
 * change that leaves both readings correct.
 *
 * @module entities/session/lib/sync-session-detail-cache
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import { sessionKeys } from '../api/query-keys';

/**
 * Merge fresh server rows into every cached detail entry they cover.
 *
 * Merged rather than replaced, and scoped to entries that already exist: the
 * detail endpoint may answer with fields the list does not carry, and a session
 * nobody has opened has no entry to keep current. Entries for sessions absent
 * from `sessions` are left untouched, so an unrelated row is never marked fresh
 * by a refresh that passed it by.
 *
 * @param queryClient - The client holding both caches.
 * @param sessions - Rows straight from the server, in any order.
 */
export function syncSessionDetailCache(
  queryClient: QueryClient,
  sessions: readonly Session[]
): void {
  if (sessions.length === 0) return;
  const fresh = new Map(sessions.map((session) => [session.id, session]));

  for (const query of queryClient.getQueryCache().findAll({ queryKey: sessionKeys.detailRoot })) {
    // Every entry under this prefix is one session's detail row (`query-keys.ts`).
    const cached = query.state.data as Session | undefined;
    const incoming = cached === undefined ? undefined : fresh.get(cached.id);
    if (incoming === undefined) continue;
    queryClient.setQueryData<Session>(query.queryKey, { ...cached, ...incoming });
  }
}
