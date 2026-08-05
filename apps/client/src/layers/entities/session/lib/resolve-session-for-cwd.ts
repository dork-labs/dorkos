/**
 * Which session a working directory should open on.
 *
 * Every surface that points the cockpit at a project has to answer this, and
 * every one of them has to answer it the same way, because a `/session` URL
 * without `?session=` is a half-loaded page: the chat renders, but no stream
 * ever attaches and the composer cannot accept text.
 *
 * **The answer cannot come from this window's cache alone.** A cockpit
 * cold-loads the session list for the ONE directory it is pointed at; every
 * other agent in the roster has an empty cache entry until something happens to
 * it. So "nothing cached" is overwhelmingly the normal state, not evidence that
 * an agent has no conversations — and reading it as evidence is what made
 * clicking an agent abandon its work and open an empty chat (DOR-928). Only the
 * server can tell the two apart, so on a miss this asks it.
 *
 * The `/session` route loader answers this question too, through this same
 * function: it needs the extra `isNew` bit to decide whether a launch-time
 * `?prompt=` seed rides along, which is the only thing it does differently.
 * Callers that already know the directory answer here rather than navigating to
 * a session-less URL and letting the loader redirect — that costs a second
 * navigation and a history `REPLACE` for the tab reconciler to absorb, and
 * leaves a frame where a new tab is named after an href it is about to lose.
 *
 * @module entities/session/lib/resolve-session-for-cwd
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { Session } from '@dorkos/shared/types';
import { reportClientError } from '@/layers/shared/lib';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';
import { sessionListQueryOptions } from '../api/session-list-query';

/** What {@link resolveSessionForCwd} needs: somewhere to look, somewhere to ask. */
export interface ResolveSessionDeps {
  /** Query client holding (and caching) the per-directory session lists. */
  queryClient: QueryClient;
  /** Transport used to ask the server when nothing is cached yet. */
  transport: Transport;
}

/** The session a directory opens on, and whether it had to be invented. */
export interface ResolvedSession {
  /** A session id that is always safe to put in a `/session` URL. */
  sessionId: string;
  /**
   * True when the directory has no conversations and this id was minted for a
   * brand-new one. The loader reads it to decide whether a launch-time
   * `?prompt=` seed may ride along — a seed must never land in an existing
   * conversation.
   */
  isNew: boolean;
}

/**
 * The most recent session for `cwd`, or a freshly minted id when that directory
 * genuinely has none.
 *
 * Answers from cache when the list is already there, and asks the server
 * otherwise — the server's answer is then cached under the same key
 * `useSessions` reads, so switching back to that agent is free.
 *
 * A minted id is speculative by design: it becomes real on the first message,
 * and navigation alone never creates a session. A failed lookup mints too — a
 * URL with no session is a dead end for the composer, so a fresh conversation
 * is the safe answer when the server cannot be reached.
 *
 * @param deps - Query client to read and fill, transport to ask over.
 * @param cwd - The target working directory, or `null` for the default one.
 * @returns The resolved session id and whether it is brand-new.
 */
export async function resolveSessionForCwd(
  deps: ResolveSessionDeps,
  cwd: string | null
): Promise<ResolvedSession> {
  const cached = cachedSessionsForCwd(deps.queryClient, cwd);
  const sessions = cached.length > 0 ? cached : await fetchSessionList(deps, cwd);
  const mostRecent = sessions[0];
  return mostRecent
    ? { sessionId: mostRecent.id, isNew: false }
    : { sessionId: crypto.randomUUID(), isNew: true };
}

/**
 * The session `cwd` is already known to be on, for the one caller that cannot
 * wait: a link's `href` has to be a string at render time, and rendering it for
 * a roster of agents must not cost a request each.
 *
 * `null` means "not known here", NOT "no sessions" — the distinction this
 * module exists to keep. A caller that gets `null` must leave `?session=` off
 * its URL and let the `/session` loader resolve it properly on arrival, never
 * mint an id of its own.
 *
 * @param queryClient - Query client holding the cached session lists.
 * @param cwd - The target working directory, or `null` for the default one.
 * @returns The most recent known session id, or `null` when none is cached.
 */
export function cachedSessionForCwd(queryClient: QueryClient, cwd: string | null): string | null {
  return cachedSessionsForCwd(queryClient, cwd)[0]?.id ?? null;
}

/** The cached session list for `cwd`, newest-first, or empty when uncached. */
function cachedSessionsForCwd(queryClient: QueryClient, cwd: string | null): Session[] {
  return queryClient.getQueryData<Session[]>(sessionKeys.list(cwd)) ?? [];
}

/**
 * Ask the server for `cwd`'s sessions, through the shared query options so the
 * answer lands in the cache exactly as `useSessions` would have left it.
 *
 * A failure answers "none" rather than propagating: the caller's job is to
 * produce a session id, and it can always mint one. But it is REPORTED rather
 * than swallowed, because the two things that land here want opposite
 * reactions. An unreachable server is expected and the fallback is right. A
 * defect in the fetch is not, and it degrades into exactly the behaviour this
 * module exists to prevent — a real conversation abandoned for a blank one,
 * with nothing on screen to say why. The reporter dedupes, so an offline
 * cockpit does not spam it.
 */
async function fetchSessionList(deps: ResolveSessionDeps, cwd: string | null): Promise<Session[]> {
  try {
    return await deps.queryClient.ensureQueryData(sessionListQueryOptions(deps, cwd));
  } catch (error) {
    reportClientError(deps.transport, error);
    return [];
  }
}
