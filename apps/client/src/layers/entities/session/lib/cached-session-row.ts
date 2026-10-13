/**
 * The row this window already holds for one session, wherever it was cached.
 *
 * Opening a chat used to ask the server for its row on every navigation and
 * wait for the answer before drawing anything (DOR-2891). Almost every chat a
 * person opens is one this window has already seen: it is a row in the sidebar's
 * Today list, in an agent's session list, or in the detail cache of a chat that
 * was open a minute ago. Those rows carry the one thing the route needs to
 * draw the chat, its own directory, so the route can open from them at once
 * and check with the server in the background.
 *
 * @module entities/session/lib/cached-session-row
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';

/** A cached session row that names the directory its reads must use. */
export type PlacedSession = Session & { cwd: string };

function isPlaced(value: unknown, sessionId: string): value is PlacedSession {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<Session>;
  return row.id === sessionId && typeof row.cwd === 'string' && row.cwd.length > 0;
}

/**
 * Find a cached row for `sessionId` that says where the session lives.
 *
 * Detail entries win over list rows, and list rows over the cross-agent recent
 * window, because that is the order of how much each knows about one session.
 * A row with no directory is skipped: opening a chat under a guessed directory
 * reads the wrong transcript (DOR-1836), so such a row is not an answer.
 *
 * @param queryClient - The query client holding the session caches.
 * @param sessionId - The session to look for.
 * @param options - `listsOnly` skips the detail entries, for a reader of the
 *   detail row itself: its own answer would otherwise move it to a new key and
 *   send the same read again.
 * @returns The cached row, or `null` when this window has none that names a
 *   directory.
 */
export function findCachedSessionRow(
  queryClient: QueryClient,
  sessionId: string,
  options: { listsOnly?: boolean } = {}
): PlacedSession | null {
  if (!options.listsOnly) {
    for (const [, row] of queryClient.getQueriesData<Session>({
      queryKey: sessionKeys.bySession(sessionId),
    })) {
      if (isPlaced(row, sessionId)) return row;
    }
  }
  for (const [, rows] of queryClient.getQueriesData<Session[]>({
    queryKey: sessionKeys.listRoot,
  })) {
    const row = Array.isArray(rows) ? rows.find((r) => r.id === sessionId) : undefined;
    if (isPlaced(row, sessionId)) return row;
  }
  for (const [, envelope] of queryClient.getQueriesData<{ sessions?: Session[] }>({
    queryKey: sessionKeys.recentRoot,
  })) {
    const row = envelope?.sessions?.find((r) => r.id === sessionId);
    if (isPlaced(row, sessionId)) return row;
  }
  return null;
}

/**
 * The agent folder whose cached list holds `sessionId`, or null.
 *
 * The key a list is cached under is the folder an agent click resolves, which
 * is not always the row's own `cwd`: a chat started in a project's subfolder
 * sits in the project's list. A list covers its folder's whole subtree, so a
 * chat can sit in several; the closest folder above it wins, never a broad
 * one somebody once opened.
 *
 * @param queryClient - The query client holding the session caches.
 * @param sessionId - The session to look for.
 */
export function findListHoldingSession(queryClient: QueryClient, sessionId: string): string | null {
  let closest: string | null = null;
  for (const [key, rows] of queryClient.getQueriesData<Session[]>({
    queryKey: sessionKeys.listRoot,
  })) {
    const cwd = key[1];
    if (typeof cwd !== 'string' || !Array.isArray(rows)) continue;
    if (!rows.some((r) => r.id === sessionId)) continue;
    // Every holder is an ancestor of the chat's folder, so the longest is the closest.
    if (closest === null || cwd.length > closest.length) closest = cwd;
  }
  return closest;
}
