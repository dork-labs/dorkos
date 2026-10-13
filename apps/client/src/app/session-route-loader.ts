import { redirect } from '@tanstack/react-router';
import { sessionLocationTarget, toSession, type SessionSearch } from '@/layers/shared/lib';
import {
  resolveSessionForCwd,
  SESSION_LOOKUP_FAILED_MESSAGE,
  sessionKeys,
  setSessionRouteContext,
  getSessionRouteContext,
  clearSessionRouteContext,
  findCachedSessionRow,
  findListHoldingSession,
  sessionDetailQueryOptions,
} from '@/layers/entities/session';
import { toast } from 'sonner';
import type { Session } from '@dorkos/shared/types';
import type { RouterContext } from './router-context';

/** Inputs whose changes require selecting a conversation again. */
export function sessionLoaderDeps({ search }: { search: SessionSearch }) {
  return {
    session: search.session,
    dir: search.dir,
    runtime: search.runtime,
    prompt: search.prompt,
    send: search.send,
    seed: search.seed,
    agentId: search.agentId,
    launchRef: search.launchRef,
    draft: search.draft,
    agentPath: search.agentPath,
    profileRef: search.profileRef,
  };
}

/** The route selection inputs. */
export type SessionLoaderDeps = Omit<
  ReturnType<typeof sessionLoaderDeps>,
  'draft' | 'agentId' | 'launchRef' | 'agentPath' | 'profileRef'
> &
  Partial<Pick<SessionSearch, 'draft' | 'agentId' | 'launchRef' | 'agentPath' | 'profileRef'>>;

/** Resolve existing sessions and explicit drafts without exposing directories. */
export async function sessionRouteLoader({
  context,
  deps,
  preload = false,
}: {
  context: RouterContext;
  deps: SessionLoaderDeps;
  /** Whether this run only warms the cache for a hover, rather than opening the page. */
  preload?: boolean;
}) {
  const profileRef =
    deps.profileRef ??
    (deps.agentPath
      ? (await context.transport.createSessionLocation(deps.agentPath)).id
      : undefined);
  const selectCwd = (sessionId: string, cwd: string, draft: boolean, runtime?: string) => {
    setSessionRouteContext(sessionId, { cwd, draft, ...(runtime && { runtime }) });
  };
  let cwd = deps.dir;
  if (deps.launchRef) cwd = (await context.transport.getSessionLocation(deps.launchRef)).cwd;
  if (deps.agentId && !cwd) {
    const paths = await context.transport.listMeshAgentPaths();
    cwd = paths.agents.find((agent) => agent.id === deps.agentId)?.projectPath;
    if (!cwd) throw new Error('Agent location is unavailable.');
  }
  if (deps.session) {
    if (deps.draft === '1') {
      try {
        const created = await context.transport.getSession(deps.session, cwd);
        if (created?.cwd) {
          selectCwd(deps.session, created.cwd, false, created.runtime);
          context.queryClient.setQueryData(sessionKeys.detail(deps.session, created.cwd), created);
          throw redirect({
            ...toSession((prev) => ({
              ...prev,
              profileRef,
              dir: undefined,
              draft: undefined,
              agentId: undefined,
              launchRef: undefined,
            })),
            replace: true,
          });
        }
      } catch (error) {
        if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 404)
          throw error;
      }
      // A copied draft resolves its launch location before any composer can run.

      if (!cwd) throw new Error('This chat’s folder isn’t available.');
      selectCwd(
        deps.session,
        cwd,
        getSessionRouteContext(deps.session)?.draft !== false,
        deps.runtime
      );
      if (deps.dir || deps.agentPath) {
        const id = deps.launchRef ?? (await context.transport.createSessionLocation(cwd)).id;
        throw redirect({
          ...toSession((prev) => ({ ...prev, profileRef, dir: undefined, launchRef: id })),
          replace: true,
        });
      }
      return;
    }
    // A chat this window already holds a row for opens at once, and the server
    // is asked behind it (DOR-2891). Only a chat it has never seen waits.
    const cached = openFromCache(context, deps.session);
    if (cached) {
      selectCwd(deps.session, cached.cwd, false, cached.runtime);
    } else {
      // Existing-session lookup errors are real errors. A missing ID cannot launch
      // a new conversation or choose a different runtime on someone's behalf.
      const session = await context.transport
        .getSession(deps.session, cwd)
        .catch((error: unknown) => openAgentInstead(context, deps.session!, error, preload));
      if (!session) throw new Error('This chat isn’t available.');
      confirmedMissing.delete(deps.session);
      if (session.cwd) {
        selectCwd(deps.session, session.cwd, false, session.runtime);
        context.queryClient.setQueryData(sessionKeys.detail(deps.session, session.cwd), session);
        context.queryClient.setQueryData(sessionKeys.detail(deps.session, null), session);
      }
    }
    if (deps.dir || deps.launchRef || deps.agentId || deps.agentPath) {
      throw redirect({
        ...toSession((prev) => ({
          ...prev,
          profileRef,
          dir: undefined,
          launchRef: undefined,
          agentId: undefined,
        })),
        replace: true,
      });
    }
    return;
  }
  if (!cwd) cwd = (await context.transport.getDefaultCwd()).path;
  const resolved = await resolveSessionForCwd(context, cwd ?? null);
  if (!resolved) throw new Error(SESSION_LOOKUP_FAILED_MESSAGE);
  const resolvedCwd = cwd ?? resolved.cwd;
  let launchRef: string | undefined;
  if (resolved.isNew) {
    if (!resolvedCwd) throw new Error('This chat’s folder isn’t available.');
    launchRef = (await context.transport.createSessionLocation(resolvedCwd)).id;
    selectCwd(resolved.sessionId, resolvedCwd, true, deps.runtime);
  }
  throw redirect({
    ...toSession((prev) => ({
      ...prev,
      profileRef,
      session: resolved.sessionId,
      dir: undefined,
      agentId: undefined,
      launchRef,
      draft: resolved.isNew ? '1' : undefined,
      runtime: deps.runtime,
      prompt: resolved.isNew ? deps.prompt : undefined,
      send: resolved.isNew ? deps.send : undefined,
      seed: resolved.isNew ? deps.seed : undefined,
    })),
    replace: true,
  });
}

/** The part of the router {@link reloadSessionMatches} drives. */
export interface ReloadableRouter {
  invalidate: (opts: { filter: (match: { search: unknown }) => boolean }) => Promise<unknown>;
}

/**
 * Make every route match for `sessionId` load again: the page showing it now,
 * and a hover preload a click would otherwise reuse without loading.
 *
 * Matches for any other chat are left valid, so a check that answers after the
 * person has moved on does not disturb the page they moved to.
 *
 * @param router - The app router.
 * @param sessionId - The chat the background check found gone.
 */
export function reloadSessionMatches(router: ReloadableRouter, sessionId: string): void {
  void router.invalidate({
    filter: (match) => (match.search as { session?: unknown } | null)?.session === sessionId,
  });
}

/**
 * Chats the server said are gone after one was opened from cache, each with the
 * agent folder to open instead (or null). Their rows can sit in caches this
 * module does not own, so without this the reload would open them from cache
 * again instead of showing the error.
 */
const confirmedMissing = new Map<string, string | null>();

/** Whether an error is the server saying the chat does not exist. */
function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && error.status === 404;
}

/**
 * When a chat opened from an agent's list turns out to be gone, open the agent.
 *
 * A row in a list can outlive its chat: a tab that was hidden misses the event
 * that removed it, and a reconnect now opens from that list at once (DOR-2891).
 * Before, the click waited for a fresh list and landed on a chat that exists, so
 * this lands where that wait would have: the agent's newest chat, saying so.
 * Once only per chat, so a second miss shows the real error rather than a loop.
 *
 * @throws A redirect to the agent folder, or `error` itself when there is none.
 */
async function openAgentInstead(
  context: RouterContext,
  sessionId: string,
  error: unknown,
  preload: boolean
): Promise<never> {
  const dir = confirmedMissing.get(sessionId);
  if (preload || !isNotFound(error) || !dir) throw error;
  confirmedMissing.set(sessionId, null);
  const target = await sessionLocationTarget(context.transport, dir);
  toast('That chat is gone. Opened the agent’s latest chat.');
  throw redirect({ ...target, replace: true });
}

/** Take a chat the server says is gone out of every cached list that holds it. */
function forgetCachedRows(context: RouterContext, sessionId: string): void {
  context.queryClient.setQueriesData<Session[]>({ queryKey: sessionKeys.listRoot }, (rows) =>
    rows?.some((row) => row.id === sessionId) ? rows.filter((row) => row.id !== sessionId) : rows
  );
  context.queryClient.setQueriesData<{ sessions?: Session[] }>(
    { queryKey: sessionKeys.recentRoot },
    (envelope) =>
      envelope?.sessions?.some((row) => row.id === sessionId)
        ? { ...envelope, sessions: envelope.sessions.filter((row) => row.id !== sessionId) }
        : envelope
  );
}

/**
 * Open an existing chat from what this window already knows, and check it
 * with the server in the background.
 *
 * The directory comes from the route context an earlier visit resolved, or from
 * any cached row for the chat (detail, an agent's list, the recent window). The
 * background read lands in the same detail entry the chat page reads, so the
 * page waits on it rather than sending its own. If the server says the chat is
 * gone, the cached knowledge is dropped and the route loads again, which then
 * waits on the server: a chat an agent's list held lands on that agent's
 * newest chat, and any other shows the real error. A hover preload's 404 does
 * the same: a click soon after would reuse the preload instead of loading
 * again, so the preload's check is the only one that click gets.
 *
 * @returns The directory and runtime to open under, or null when this window
 *   has nothing to open from.
 */
function openFromCache(
  context: RouterContext,
  sessionId: string
): { cwd: string; runtime?: string } | null {
  if (confirmedMissing.has(sessionId)) return null;
  const known = getSessionRouteContext(sessionId);
  // A chat still being started is not opened from cache: its rows can be the
  // optimistic ones a first message writes, and it has its own draft path.
  if (known?.draft) return null;
  const row = known ? null : findCachedSessionRow(context.queryClient, sessionId);
  const placed = known
    ? { cwd: known.cwd, runtime: known.runtime }
    : row
      ? { cwd: row.cwd, runtime: row.runtime }
      : null;
  if (!placed) return null;
  context.queryClient
    // Always asked, as every visit used to ask before drawing: a cached detail
    // entry can be a settings write or an optimistic row rather than the
    // server's answer. Concurrent asks (a redirect's second run, the page's own
    // read) share this one request.
    .fetchQuery({ ...sessionDetailQueryOptions(context, sessionId, placed.cwd), staleTime: 0 })
    .then((session) => {
      if (!session.cwd || getSessionRouteContext(sessionId)?.draft) return;
      // The server places a chat by id whatever directory it was asked under,
      // so a wrong cached directory never 404s. Correct it, and the runtime,
      // from the answer, which is what every visit used to do by waiting for it
      // (DOR-1836). The answer is filed under the corrected directory too, so
      // the readers that follow the context there find it instead of asking.
      const movedCwd = session.cwd !== placed.cwd;
      if (!movedCwd && (!session.runtime || session.runtime === placed.runtime)) return;
      if (movedCwd) {
        context.queryClient.setQueryData(sessionKeys.detail(sessionId, session.cwd), session);
        context.queryClient.setQueryData(sessionKeys.nativeDetail(sessionId, session.cwd), session);
      }
      const runtime = session.runtime ?? placed.runtime;
      setSessionRouteContext(sessionId, {
        cwd: session.cwd,
        draft: false,
        ...(runtime && { runtime }),
      });
    })
    .catch((error: unknown) => {
      if (!isNotFound(error)) return;
      confirmedMissing.set(sessionId, findListHoldingSession(context.queryClient, sessionId));
      if (!getSessionRouteContext(sessionId)?.draft) clearSessionRouteContext(sessionId);
      context.queryClient.removeQueries({ queryKey: sessionKeys.detail(sessionId, placed.cwd) });
      forgetCachedRows(context, sessionId);
      // The page showing this chat, and a preload a click would reuse, load
      // again; the page a person has moved on to is left alone.
      context.reloadRoute?.(sessionId);
    });
  return placed;
}
