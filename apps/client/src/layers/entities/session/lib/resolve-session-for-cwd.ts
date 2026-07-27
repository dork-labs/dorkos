/**
 * Which session a working directory should open on.
 *
 * Every surface that points the cockpit at a project has to answer this, and
 * every one of them has to answer it the same way, because a `/session` URL
 * without `?session=` is a half-loaded page: the chat renders, but no stream
 * ever attaches and the composer cannot accept text.
 *
 * The `/session` route loader answers it too, and does so reliably — its
 * `loaderDeps` declare the params it reads, so it re-runs whenever they change.
 * Answering here as well is not redundancy, it is choosing the cheaper route:
 * navigating to a session-less URL means the loader immediately redirects,
 * which costs a second navigation and a history `REPLACE` for the tab
 * reconciler to absorb, and leaves a frame where a new tab is named after an
 * href it is about to lose. A caller that already knows the directory can skip
 * all of that by naming the session up front.
 *
 * The loader cannot simply call this: it also decides whether a launch-time
 * `?prompt=` seed rides along, which depends on the branch it takes. So this is
 * the shared answer for callers, not for the loader.
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
