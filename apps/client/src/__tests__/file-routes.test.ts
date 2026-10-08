import { describe, it, expect, vi } from 'vitest';
import { createMemoryHistory } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { createAppRouter } from '../router';

// Cold route chunk transforms contend with the other client suites.
vi.setConfig({ testTimeout: 15_000 });

async function loadRoute(url: string) {
  const router = createAppRouter(new QueryClient(), createMockTransport());
  router.update({
    context: router.options.context,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  return router;
}

describe('file route behavior', () => {
  it('keeps home surfaces inside both pathless layouts and one header identity', async () => {
    const router = await loadRoute('/activity?categories=session&onboarding=welcome');
    expect(router.state.matches.map((match) => match.routeId)).toEqual([
      '__root__',
      '/_shell',
      '/_shell/_home',
      '/_shell/_home/activity',
    ]);
    expect((router.state.matches.at(-1)?.search as Record<string, unknown>)?.categories).toBe(
      'session'
    );
    const paths = ['/', '/activity', '/tasks', '/workspaces'];
    const headers = paths.map(
      (path) => router.routesByPath[path as '/'].options.staticData?.header
    );
    expect(new Set(headers).size).toBe(1);
  });

  it('keeps marketplace sources beside marketplace instead of nesting its page', async () => {
    const router = await loadRoute('/marketplace/sources');
    expect(router.state.matches.map((match) => match.routeId)).toEqual([
      '__root__',
      '/_shell',
      '/_shell/marketplace_/sources',
    ]);
  });

  it('keeps extension pages as siblings and their query values exact', async () => {
    const router = await loadRoute('/x/flow/p/one?version=1.10&custom=001');
    expect(router.state.matches.map((match) => match.routeId)).toEqual([
      '__root__',
      '/_shell',
      '/_shell/x/$extensionId_/$',
    ]);
    expect(router.state.matches.at(-1)?.params).toMatchObject({
      extensionId: 'flow',
      _splat: 'p/one',
    });
    expect(router.state.matches.at(-1)?.search).toMatchObject({ version: '1.10', custom: '001' });
  });

  it('normalizes the agents alias and carries its search to team', async () => {
    const router = await loadRoute('/agents?view=list&owner=alice');
    await router.load();
    expect(router.state.location.pathname).toBe('/team');
    expect(router.state.location.search).toMatchObject({ view: 'table', owner: 'alice' });
  });

  it('retains legacy home session links', async () => {
    const router = await loadRoute('/?session=legacy-session&dir=%2Fproject');
    await router.load();
    expect(router.state.location.pathname).toBe('/session');
    expect(router.state.location.search).toMatchObject({ session: 'legacy-session' });
  });

  it('retains app-wide legacy relay redirects', async () => {
    const router = await loadRoute('/tasks?relay=open');
    await router.load();
    expect(router.state.location.pathname).toBe('/connections');
    expect(router.state.location.search).not.toHaveProperty('relay');
  });
});
