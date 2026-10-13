import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport, createMockSession } from '@dorkos/test-utils';
import { sessionRouteLoader, sessionLoaderDeps, reloadSessionMatches } from '../router';
import { sessionSearchSchema, newSessionTarget } from '@/layers/shared/lib';
import {
  clearSessionRouteContext,
  getSessionRouteContext,
  sessionKeys,
  setSessionRouteContext,
} from '@/layers/entities/session';
import type { Session } from '@dorkos/shared/types';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: vi.fn() }));

let transport: ReturnType<typeof createMockTransport>;
let queryClient: QueryClient;
beforeEach(() => {
  // The route context is a module-level store: a chat an earlier test resolved
  // would otherwise open from it here without asking the server.
  for (const id of [
    'existing',
    'missing',
    'a',
    'b',
    'cached',
    'gone',
    'gone2',
    'gone3',
    'gone4',
    'hovered',
  ])
    clearSessionRouteContext(id);
  transport = createMockTransport();
  reloadRoute = vi.fn<(sessionId: string) => void>();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(transport.createSessionLocation).mockResolvedValue({ id: 'opaque-location' });
  vi.mocked(transport.getSessionLocation).mockResolvedValue({ cwd: '/chosen/project' });
  vi.mocked(transport.getDefaultCwd).mockResolvedValue({ path: '/default' });
  vi.mocked(transport.listSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(transport.getSession).mockResolvedValue(
    createMockSession({ id: 'existing', cwd: '/actual/project' })
  );
});
let reloadRoute: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
function run(search: Parameters<typeof sessionSearchSchema.parse>[0]) {
  return sessionRouteLoader({
    context: { queryClient, transport, reloadRoute },
    deps: sessionLoaderDeps({ search: sessionSearchSchema.parse(search) }),
  });
}
async function destination(search: Parameters<typeof sessionSearchSchema.parse>[0]) {
  try {
    await run(search);
  } catch (error) {
    return (
      error as { options: { search: (prev: Record<string, unknown>) => Record<string, unknown> } }
    ).options.search(search as Record<string, unknown>);
  }
  throw new Error('Expected redirect');
}

describe('session route identity and launch lifecycle', () => {
  it('resolves ID-only links, caches detail and resolves the actual cwd without redirecting', async () => {
    await run({ session: 'existing' });
    expect(transport.getSession).toHaveBeenCalledWith('existing', undefined);
    expect(
      queryClient.getQueryData(sessionKeys.detail('existing', '/actual/project'))
    ).toMatchObject({ id: 'existing' });
    expect(getSessionRouteContext('existing')).toEqual({
      cwd: '/actual/project',
      draft: false,
      runtime: 'claude-code',
    });
  });
  it('does not turn an unknown existing session into a new one', async () => {
    const missing = Object.assign(new Error('Missing'), { status: 404 });
    vi.mocked(transport.getSession).mockRejectedValue(missing);
    await expect(run({ session: 'missing' })).rejects.toBe(missing);
    expect(transport.createSessionLocation).not.toHaveBeenCalled();
  });
  it('preserves outages as errors', async () => {
    const unavailable = Object.assign(new Error('Unavailable'), { status: 503 });
    vi.mocked(transport.getSession).mockRejectedValue(unavailable);
    await expect(run({ session: 'existing' })).rejects.toBe(unavailable);
  });
  it('normalizes legacy directory links while keeping message and dialog context', async () => {
    expect(
      await destination({
        session: 'existing',
        dir: '/legacy',
        message: 'message-1',
        panel: 'profile',
      })
    ).toMatchObject({
      session: 'existing',
      dir: undefined,
      message: 'message-1',
      panel: 'profile',
    });
    expect(transport.getSession).toHaveBeenCalledWith('existing', '/legacy');
  });
  it('keeps a separately addressed profile while hiding the conversation directory', async () => {
    const search = await destination({
      session: 'existing',
      dir: '/host',
      panel: 'profile',
      agentPath: '/linked',
      profilePage: 'tools',
    });
    expect(transport.createSessionLocation).toHaveBeenCalledWith('/linked');
    expect(search).toMatchObject({
      session: 'existing',
      panel: 'profile',
      profilePage: 'tools',
      profileRef: 'opaque-location',
      dir: undefined,
      agentPath: undefined,
    });
    expect(getSessionRouteContext('existing')?.cwd).toBe('/actual/project');
  });
  it.each(['claude-code', 'codex', 'opencode'])(
    'resolves a portable %s draft before creation',
    async (runtime) => {
      vi.mocked(transport.getSession).mockRejectedValue(
        Object.assign(new Error('Draft'), { status: 404 })
      );
      await run({ session: `draft-${runtime}`, draft: '1', launchRef: 'opaque-location', runtime });
      expect(transport.getSessionLocation).toHaveBeenCalledWith('opaque-location');
      expect(transport.getSession).toHaveBeenCalledWith(`draft-${runtime}`, '/chosen/project');
      expect(getSessionRouteContext(`draft-${runtime}`)).toEqual({
        cwd: '/chosen/project',
        draft: true,
        runtime,
      });
    }
  );
  it('does not open a copied draft in an unrelated default directory', async () => {
    vi.mocked(transport.getSession).mockRejectedValue(
      Object.assign(new Error('Missing draft'), { status: 404 })
    );
    await expect(run({ session: 'missing-location', draft: '1' })).rejects.toThrow(
      'This chat’s folder isn’t available'
    );
    expect(transport.getDefaultCwd).not.toHaveBeenCalled();
  });
  it('promotes a draft only after its native transcript exists', async () => {
    const target = await destination({
      session: 'existing',
      draft: '1',
      launchRef: 'opaque-location',
      runtime: 'claude-code',
    });
    expect(target.draft).toBeUndefined();
    expect(target.launchRef).toBeUndefined();
    expect(target.session).toBe('existing');
    expect(getSessionRouteContext('existing')?.draft).toBe(false);
  });
  it('refuses an invalid launch reference instead of using the default directory', async () => {
    vi.mocked(transport.getSessionLocation).mockRejectedValue(new Error('Missing location'));
    await expect(run({ session: 'draft', draft: '1', launchRef: 'missing' })).rejects.toThrow(
      'Missing location'
    );
    expect(transport.getDefaultCwd).not.toHaveBeenCalled();
  });
  it('resolves known agents through their opaque ID', async () => {
    vi.mocked(transport.listMeshAgentPaths).mockResolvedValue({
      agents: [{ id: 'agent-1', name: 'Agent', projectPath: '/agent/project' }],
    });
    vi.mocked(transport.getSession).mockRejectedValue(
      Object.assign(new Error('Draft'), { status: 404 })
    );
    await run({ session: 'agent-draft', agentId: 'agent-1', draft: '1', runtime: 'codex' });
    expect(getSessionRouteContext('agent-draft')?.cwd).toBe('/agent/project');
  });
  it('creates a portable draft for an empty directory preserving launch intent', async () => {
    const target = await destination({
      dir: '/empty',
      runtime: 'opencode',
      prompt: 'hello',
      send: '1',
      seed: 'dorkbot-help',
      panel: 'profile',
    });
    expect(target).toMatchObject({
      draft: '1',
      launchRef: 'opaque-location',
      dir: undefined,
      runtime: 'opencode',
      prompt: 'hello',
      send: '1',
      seed: 'dorkbot-help',
      panel: 'profile',
    });
    expect(target.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(transport.createSessionLocation).toHaveBeenCalledWith('/empty');
  });
  it('resumes a real conversation and drops instructions aimed at a fresh one', async () => {
    vi.mocked(transport.listSessions).mockResolvedValue({
      sessions: [createMockSession({ id: 'existing', cwd: '/actual/project' })],
    });
    const target = await destination({
      dir: '/actual/project',
      prompt: 'do this',
      send: '1',
      seed: 'dorkbot-help',
      panel: 'profile',
    });
    expect(target).toMatchObject({
      session: 'existing',
      dir: undefined,
      draft: undefined,
      prompt: undefined,
      send: undefined,
      seed: undefined,
      panel: 'profile',
    });
    expect(transport.createSessionLocation).not.toHaveBeenCalled();
  });
  it('fails lookup rather than minting a session on an unreachable server', async () => {
    vi.mocked(transport.listSessions).mockRejectedValue(new Error('Offline'));
    await expect(run({ dir: '/unreachable' })).rejects.toThrow();
    expect(transport.createSessionLocation).not.toHaveBeenCalled();
  });
  it('keeps each resolved session location separate when tabs switch', async () => {
    await run({ session: 'a' });
    vi.mocked(transport.getSession).mockResolvedValue(
      createMockSession({ id: 'b', cwd: '/other' })
    );
    await run({ session: 'b' });
    expect(getSessionRouteContext('a')?.cwd).toBe('/actual/project');
    expect(getSessionRouteContext('b')?.cwd).toBe('/other');
  });
  it('builds a new session without exposing its directory and retains runtime choices', async () => {
    const target = await newSessionTarget(transport, {
      dir: '/private/project',
      runtime: 'codex',
      continuedFrom: 'prior',
    });
    expect(target.search.dir).toBeUndefined();
    expect(target.search).toMatchObject({
      launchRef: 'opaque-location',
      draft: '1',
      runtime: 'codex',
      continuedFrom: 'prior',
    });
  });
  it('ignores dialogs as loader dependencies', () => {
    expect(
      sessionLoaderDeps({ search: sessionSearchSchema.parse({ session: 'a', panel: 'profile' }) })
    ).not.toHaveProperty('panel');
  });
});

describe('opening a chat this window already knows (DOR-2891)', () => {
  /** A getSession that never answers: a loader that waits on it never returns. */
  function serverHangs() {
    vi.mocked(transport.getSession).mockImplementation(() => new Promise<Session>(() => {}));
  }

  it('opens from a cached list row without waiting on the server', async () => {
    queryClient.setQueryData(sessionKeys.list('/agent'), [
      createMockSession({ id: 'cached', cwd: '/agent/sub', runtime: 'codex' }),
    ]);
    serverHangs();
    await run({ session: 'cached' });
    expect(getSessionRouteContext('cached')).toEqual({
      cwd: '/agent/sub',
      draft: false,
      runtime: 'codex',
    });
    // Still checked, under the row's own directory, in the background.
    expect(transport.getSession).toHaveBeenCalledWith('cached', '/agent/sub');
  });

  it('opens from the cross-agent recent window too', async () => {
    queryClient.setQueryData(sessionKeys.recent(20), {
      sessions: [createMockSession({ id: 'cached', cwd: '/recent' })],
    });
    serverHangs();
    await run({ session: 'cached' });
    expect(getSessionRouteContext('cached')?.cwd).toBe('/recent');
  });

  it('reopens a chat it resolved before without waiting', async () => {
    await run({ session: 'existing' });
    serverHangs();
    await run({ session: 'existing' });
    expect(getSessionRouteContext('existing')?.cwd).toBe('/actual/project');
  });

  it('asks once while a check of the same chat is already out', async () => {
    queryClient.setQueryData(sessionKeys.list('/agent'), [
      createMockSession({ id: 'cached', cwd: '/agent' }),
    ]);
    // A legacy link's redirect runs the loader twice in a row.
    await run({ session: 'cached' });
    await run({ session: 'cached' });
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(sessionKeys.detail('cached', '/agent'))).toBeDefined()
    );
    expect(transport.getSession).toHaveBeenCalledTimes(1);
  });

  it('still drops a legacy directory from the address', async () => {
    queryClient.setQueryData(sessionKeys.list('/agent'), [
      createMockSession({ id: 'cached', cwd: '/agent' }),
    ]);
    serverHangs();
    expect(await destination({ session: 'cached', dir: '/agent' })).toMatchObject({
      session: 'cached',
      dir: undefined,
    });
  });

  it('opens the agent instead when a chat opened from its list is gone', async () => {
    // A hidden tab can miss the event that removed a chat, and a reconnect now
    // opens from that list at once. Waiting for a fresh list used to land on a
    // chat that exists; so does this.
    queryClient.setQueryData(sessionKeys.list('/agent'), [
      createMockSession({ id: 'gone', cwd: '/agent' }),
      createMockSession({ id: 'kept', cwd: '/agent' }),
    ]);
    const missing = Object.assign(new Error('Missing'), { status: 404 });
    vi.mocked(transport.getSession).mockRejectedValue(missing);
    await run({ session: 'gone' });
    await vi.waitFor(() => expect(reloadRoute).toHaveBeenCalledWith('gone'));
    expect(getSessionRouteContext('gone')).toBeUndefined();
    expect(
      queryClient.getQueryData<Session[]>(sessionKeys.list('/agent'))?.map((s) => s.id)
    ).toEqual(['kept']);
    const redirected = await run({ session: 'gone' }).catch((error: unknown) => error);
    expect((redirected as { options: { search: unknown } }).options.search).toMatchObject({
      launchRef: 'opaque-location',
    });
    expect(transport.createSessionLocation).toHaveBeenCalledWith('/agent');
    // Said, not swapped in silently.
    expect(toast).toHaveBeenCalledWith('That chat is gone. Opened the agent’s latest chat.');
    // Once only: a second miss is the real error, never a loop.
    await expect(run({ session: 'gone' })).rejects.toBe(missing);
  });

  it('shows the real error for a gone chat this window had opened itself', async () => {
    setSessionRouteContext('gone2', { cwd: '/agent', draft: false });
    const missing = Object.assign(new Error('Missing'), { status: 404 });
    vi.mocked(transport.getSession).mockRejectedValue(missing);
    await run({ session: 'gone2' });
    await vi.waitFor(() => expect(reloadRoute).toHaveBeenCalledWith('gone2'));
    await expect(run({ session: 'gone2' })).rejects.toBe(missing);
  });

  it('a hover preload’s 404 still reaches the click that reuses it', async () => {
    // A click within the preload's stale time reuses its match without loading
    // again, so the preload's background check is the only one that click gets.
    queryClient.setQueryData(sessionKeys.list('/agent'), [
      createMockSession({ id: 'hovered', cwd: '/agent' }),
    ]);
    const missing = Object.assign(new Error('Missing'), { status: 404 });
    vi.mocked(transport.getSession).mockRejectedValue(missing);
    await sessionRouteLoader({
      context: { queryClient, transport, reloadRoute },
      deps: sessionLoaderDeps({ search: sessionSearchSchema.parse({ session: 'hovered' }) }),
      preload: true,
    });
    await vi.waitFor(() => expect(reloadRoute).toHaveBeenCalledWith('hovered'));
    // The preload's own second run leaves the fallback to the click…
    await expect(
      sessionRouteLoader({
        context: { queryClient, transport, reloadRoute },
        deps: sessionLoaderDeps({ search: sessionSearchSchema.parse({ session: 'hovered' }) }),
        preload: true,
      })
    ).rejects.toBe(missing);
    // …which lands on the agent.
    const redirected = await run({ session: 'hovered' }).catch((error: unknown) => error);
    expect((redirected as { options: { search: unknown } }).options.search).toMatchObject({
      launchRef: 'opaque-location',
    });
  });

  it('opens the agent whose list held the chat, not the chat’s own subfolder', async () => {
    // A broad folder somebody once opened holds it too, and is not the agent.
    queryClient.setQueryData(sessionKeys.list('/'), [
      createMockSession({ id: 'gone3', cwd: '/project/apps/desktop' }),
    ]);
    queryClient.setQueryData(sessionKeys.list('/project'), [
      createMockSession({ id: 'gone3', cwd: '/project/apps/desktop' }),
    ]);
    vi.mocked(transport.getSession).mockRejectedValue(
      Object.assign(new Error('Missing'), { status: 404 })
    );
    await run({ session: 'gone3' });
    await vi.waitFor(() => expect(reloadRoute).toHaveBeenCalledWith('gone3'));
    await run({ session: 'gone3' }).catch(() => {});
    expect(transport.createSessionLocation).toHaveBeenCalledWith('/project');
  });

  it('shows the real error for a gone chat no agent list holds', async () => {
    queryClient.setQueryData(sessionKeys.recent(20), {
      sessions: [createMockSession({ id: 'gone4', cwd: '/recent' })],
    });
    const missing = Object.assign(new Error('Missing'), { status: 404 });
    vi.mocked(transport.getSession).mockRejectedValue(missing);
    await run({ session: 'gone4' });
    await vi.waitFor(() => expect(reloadRoute).toHaveBeenCalledWith('gone4'));
    await expect(run({ session: 'gone4' })).rejects.toBe(missing);
  });

  it('corrects a stale directory from the server’s answer', async () => {
    await run({ session: 'existing' });
    expect(getSessionRouteContext('existing')?.cwd).toBe('/actual/project');
    vi.mocked(transport.getSession).mockResolvedValue(
      createMockSession({ id: 'existing', cwd: '/moved/project' })
    );
    await run({ session: 'existing' });
    await vi.waitFor(() => expect(getSessionRouteContext('existing')?.cwd).toBe('/moved/project'));
    // Filed under the corrected directory too, so the page's read there does
    // not ask a second time.
    expect(
      queryClient.getQueryData(sessionKeys.detail('existing', '/moved/project'))
    ).toMatchObject({ cwd: '/moved/project' });
  });

  it('corrects a placeholder runtime from the server’s answer', async () => {
    setSessionRouteContext('cached', { cwd: '/agent', draft: false, runtime: 'claude-code' });
    vi.mocked(transport.getSession).mockResolvedValue(
      createMockSession({ id: 'cached', cwd: '/agent', runtime: 'codex' })
    );
    await run({ session: 'cached' });
    await vi.waitFor(() => expect(getSessionRouteContext('cached')?.runtime).toBe('codex'));
  });

  it('leaves a chat still being started to its own draft path', async () => {
    setSessionRouteContext('cached', { cwd: '/agent', draft: true });
    queryClient.setQueryData(sessionKeys.list('/agent'), [
      createMockSession({ id: 'cached', cwd: '/agent' }),
    ]);
    const missing = Object.assign(new Error('Missing'), { status: 404 });
    vi.mocked(transport.getSession).mockRejectedValue(missing);
    await expect(run({ session: 'cached' })).rejects.toBe(missing);
    expect(getSessionRouteContext('cached')?.draft).toBe(true);
  });

  it('does not count an outage as the chat being gone', async () => {
    queryClient.setQueryData(sessionKeys.list('/agent'), [
      createMockSession({ id: 'cached', cwd: '/agent' }),
    ]);
    vi.mocked(transport.getSession).mockRejectedValue(
      Object.assign(new Error('Unavailable'), { status: 503 })
    );
    await run({ session: 'cached' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reloadRoute).not.toHaveBeenCalled();
    expect(getSessionRouteContext('cached')?.cwd).toBe('/agent');
  });
});

describe('reloading after a background check (DOR-2891)', () => {
  it('reloads every match for the gone chat, and only those', () => {
    const invalidate = vi.fn(
      async (_opts: { filter: (match: { search: unknown }) => boolean }) => {}
    );
    reloadSessionMatches({ invalidate }, 'gone');
    const { filter } = invalidate.mock.calls[0]![0];
    expect(filter({ search: { session: 'gone' } })).toBe(true);
    expect(filter({ search: { session: 'other' } })).toBe(false);
    expect(filter({ search: {} })).toBe(false);
  });
});
