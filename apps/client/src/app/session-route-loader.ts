import { redirect } from '@tanstack/react-router';
import { toSession, type SessionSearch } from '@/layers/shared/lib';
import {
  resolveSessionForCwd,
  SESSION_LOOKUP_FAILED_MESSAGE,
  sessionKeys,
  setSessionRouteContext,
  getSessionRouteContext,
} from '@/layers/entities/session';
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
}: {
  context: RouterContext;
  deps: SessionLoaderDeps;
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

      if (!cwd) throw new Error('Session location is unavailable.');
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
    // Existing-session lookup errors are real errors. A missing ID cannot launch
    // a new conversation or choose a different runtime on someone's behalf.
    const session = await context.transport.getSession(deps.session, cwd);
    if (!session) throw new Error('Session is unavailable.');
    if (session.cwd) {
      selectCwd(deps.session, session.cwd, false, session.runtime);
      context.queryClient.setQueryData(sessionKeys.detail(deps.session, session.cwd), session);
      context.queryClient.setQueryData(sessionKeys.detail(deps.session, null), session);
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
    if (!resolvedCwd) throw new Error('Session location is unavailable.');
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
