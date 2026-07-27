/**
 * Which session a working directory should open on.
 *
 * Every surface that points the cockpit at a project has to answer this, and
 * every one of them has to answer it the same way, because a `/session` URL
 * without `?session=` is a half-loaded page: the chat renders, but no stream
 * ever attaches and the composer cannot accept text. The `/session` route
 * loader answers it too, but only when the route is entered fresh — it declares
 * no `loaderDeps`, so changing search params within `/session` does not re-run
 * it. Anything building a `/session` target from inside the app must therefore
 * carry its own answer rather than expect the loader to fill the gap.
 *
 * @module entities/session/lib/resolve-session-for-cwd
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';

/**
 * The most recent cached session for `cwd`, or a fresh id when that directory
 * has none. Speculative by design: a minted id becomes real on the first
 * message, and reading a stale cache costs nothing worse than landing on a
 * session that the list refresh then supersedes.
 *
 * @param queryClient - Query client holding the cached session lists.
 * @param cwd - The target working directory, or `null` for the default one.
 * @returns A session id that is always safe to put in a `/session` URL.
 */
export function resolveSessionForCwd(queryClient: QueryClient, cwd: string | null): string {
  const cached = queryClient.getQueryData<Session[]>(['sessions', cwd ?? null]);
  return cached?.[0]?.id ?? crypto.randomUUID();
}
