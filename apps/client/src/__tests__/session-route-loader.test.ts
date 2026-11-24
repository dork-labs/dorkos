// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { createMockTransport, createMockSession } from '@dorkos/test-utils/mock-factories';
import { sessionRouteLoader, sessionLoaderDeps, reloadSessionMatches } from '../router';
import { createAppRouterWithoutPages } from '../test-helpers/app-router-without-pages';
import { sessionSearchSchema, newSessionTarget } from '@/layers/shared/lib';
import {
  clearSessionRouteContext,
  getSessionRouteContext,
  sessionKeys,
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
function run(search: Parameters<typeof sessionSearchSchema.parse>[0], preload = false) {
  return sessionRouteLoader({
    context: { queryClient, transport, reloadRoute },
    deps: sessionLoaderDeps({ search: sessionSearchSchema.parse(search) }),
    preload,
  });
}
function appRouterWithoutPages() {
  return createAppRouterWithoutPages(queryClient, transport);
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
    expect(transport.allocateSession).not.toHaveBeenCalled();
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
  it.each(['claude-code', 'codex', 'opencode'])(
    'resolves a portable %s draft before creation',
    async (runtime) => {
      vi.mocked(transport.getSession).mockRejectedValue(
        Object.assign(new Error('Draft'), { status: 404 })
      );
      await run({ session: `draft-${runtime}`, draft: '1', launchRef: 'opaque-location', runtime });
      expect(transport.getSessionLocation).toHaveBeenCalledWith('opaque-location');
      expect(transport.allocateSession).not.toHaveBeenCalled();
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
  it('creates a portable draft for an empty directory preserving launch intent', async () => {
    vi.mocked(transport.allocateSession).mockResolvedValueOnce({ sessionId: 'bound-to-receipt' });
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
    expect(target.session).toBe('bound-to-receipt');
    expect(transport.createSessionLocation).toHaveBeenCalledWith('/empty');
    expect(transport.allocateSession).toHaveBeenCalledExactlyOnceWith({
      kind: 'location',
      launchRef: 'opaque-location',
    });
  });
  it('keeps an agent launch opaque and refuses an unavailable registration before allocation', async () => {
    vi.mocked(transport.listMeshAgentPaths).mockResolvedValue({
      agents: [{ id: 'registered', name: 'Scout', projectPath: '/agents/scout' }],
    });
    vi.mocked(transport.allocateSession).mockResolvedValueOnce({ sessionId: 'acknowledged' });
    await expect(destination({ agentId: 'registered', runtime: 'doe' })).resolves.toMatchObject({
      session: 'acknowledged',
      agentId: 'registered',
      draft: '1',
      runtime: 'doe',
    });
    await expect(run({ agentId: 'gone' })).rejects.toThrow('Agent location is unavailable.');
    expect(transport.createSessionLocation).not.toHaveBeenCalled();
    expect(transport.getDefaultCwd).not.toHaveBeenCalled();
    expect(transport.allocateSession).toHaveBeenCalledExactlyOnceWith({
      kind: 'registered-agent',
      agentId: 'registered',
    });
  });

  it('allocates once when the real router click overlaps a read-only intent preload', async () => {
    let resolveLookup!: (value: { sessions: Session[] }) => void;
    const lookup = new Promise<{ sessions: Session[] }>((resolve) => {
      resolveLookup = resolve;
    });
    vi.mocked(transport.listSessions).mockReturnValue(lookup);
    vi.mocked(transport.getSession).mockImplementation(async (id) => {
      if (id === 'existing') return createMockSession({ id, cwd: '/active' });
      throw Object.assign(new Error('Pending chat'), { status: 404 });
    });
    vi.mocked(transport.allocateSession).mockResolvedValueOnce({
      sessionId: 'hover-then-click',
      launchRef: 'opaque-location',
    });
    const router = appRouterWithoutPages();
    router.update({
      context: router.options.context,
      history: createMemoryHistory({ initialEntries: ['/session?session=existing'] }),
    });
    await router.load();
    const options = { to: '/session' as const, search: { launchRef: 'opaque-location' } };
    const preloading = router.preloadRoute(options);
    await vi.waitFor(() => expect(transport.listSessions).toHaveBeenCalled());
    expect(transport.createSessionLocation).not.toHaveBeenCalled();
    expect(transport.allocateSession).not.toHaveBeenCalled();

    const navigation = router.navigate(options);
    resolveLookup({ sessions: [] });
    await Promise.all([preloading, navigation]);
    expect(router.state.location.search).toMatchObject({
      session: 'hover-then-click',
      launchRef: 'opaque-location',
      draft: '1',
    });
    expect(transport.createSessionLocation).not.toHaveBeenCalled();
    expect(transport.allocateSession).toHaveBeenCalledExactlyOnceWith({
      kind: 'location',
      launchRef: 'opaque-location',
    });
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
    expect(transport.allocateSession).not.toHaveBeenCalled();
  });
  it('fails lookup rather than minting a session on an unreachable server', async () => {
    vi.mocked(transport.listSessions).mockRejectedValue(new Error('Offline'));
    await expect(run({ dir: '/unreachable' })).rejects.toThrow();
    expect(transport.createSessionLocation).not.toHaveBeenCalled();
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

  it('opens the agent instead when a chat opened from its list is gone', async () => {
    // A hidden tab can miss the event that removed a chat, and a reconnect now opens from that
    // list at once.
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
