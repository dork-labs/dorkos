import { describe, it, expect, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { sessionRouteLoader } from '../router';
import type { Session } from '@dorkos/shared/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('sessionRouteLoader', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  /** Helper to invoke the loader and catch the redirect throw. */
  function callLoader(searchStr: string) {
    try {
      sessionRouteLoader({
        context: { queryClient },
        location: { searchStr },
      });
      return { redirected: false } as const;
    } catch (thrown: unknown) {
      // TanStack Router redirect() throws a Response-like object with an `options` property
      const opts = (thrown as { options: Record<string, unknown> }).options;
      return { redirected: true, redirect: opts };
    }
  }

  it('does not redirect when session param is already present', () => {
    const result = callLoader('?session=abc-123');
    expect(result.redirected).toBe(false);
  });

  it('redirects to cached session when sessions exist', () => {
    const sessions: Session[] = [
      {
        id: 'cached-s1',
        title: 'First session',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
        permissionMode: 'default',
      },
      {
        id: 'cached-s2',
        title: 'Second session',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T10:00:00Z',
        permissionMode: 'default',
      },
    ];
    queryClient.setQueryData(['sessions', null], sessions);

    const result = callLoader('');
    expect(result.redirected).toBe(true);
    expect(result.redirect).toMatchObject({
      to: '/session',
      search: { session: 'cached-s1' },
      replace: true,
    });
  });

  it('redirects to new UUID when no cached sessions', () => {
    const result = callLoader('');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toMatch(UUID_REGEX);
    expect(result.redirect).toMatchObject({
      to: '/session',
      replace: true,
    });
  });

  it('preserves dir param when redirecting to cached session', () => {
    const sessions: Session[] = [
      {
        id: 's1',
        title: 'Session',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
        permissionMode: 'default',
      },
    ];
    queryClient.setQueryData(['sessions', '/my/project'], sessions);

    const result = callLoader('?dir=/my/project');
    expect(result.redirected).toBe(true);
    expect(result.redirect).toMatchObject({
      search: { session: 's1', dir: '/my/project' },
    });
  });

  it('preserves dir param when redirecting to new UUID', () => {
    const result = callLoader('?dir=/my/project');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toMatch(UUID_REGEX);
    expect(search.dir).toBe('/my/project');
  });

  it('uses correct cache key with dir param', () => {
    // Sessions are cached under ['sessions', dir] — dir=null when absent
    const sessionsForProject: Session[] = [
      {
        id: 'proj-s1',
        title: 'Project session',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
        permissionMode: 'default',
      },
    ];
    // Put sessions under the wrong key (null instead of dir)
    queryClient.setQueryData(['sessions', null], sessionsForProject);

    // Loader should look under ['sessions', '/my/project'] — will find nothing
    const result = callLoader('?dir=/my/project');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    // Should get a new UUID, not 'proj-s1', because the cache key didn't match
    expect(search.session).toMatch(UUID_REGEX);
    expect(search.session).not.toBe('proj-s1');
  });
});
