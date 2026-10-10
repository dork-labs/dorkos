import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport, createMockSession } from '@dorkos/test-utils';
import { sessionRouteLoader, sessionLoaderDeps } from '../router';
import { sessionSearchSchema, newSessionTarget } from '@/layers/shared/lib';
import { getSessionRouteContext, sessionKeys } from '@/layers/entities/session';

let transport: ReturnType<typeof createMockTransport>;
let queryClient: QueryClient;
beforeEach(() => {
  transport = createMockTransport();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(transport.createSessionLocation).mockResolvedValue({ id: 'opaque-location' });
  vi.mocked(transport.getSessionLocation).mockResolvedValue({ cwd: '/chosen/project' });
  vi.mocked(transport.getDefaultCwd).mockResolvedValue({ path: '/default' });
  vi.mocked(transport.listSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(transport.getSession).mockResolvedValue(
    createMockSession({ id: 'existing', cwd: '/actual/project' })
  );
});
function run(search: Parameters<typeof sessionSearchSchema.parse>[0]) {
  return sessionRouteLoader({
    context: { queryClient, transport },
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
