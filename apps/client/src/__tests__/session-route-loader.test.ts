import { describe, it, expect, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { sessionRouteLoader, sessionLoaderDeps, sessionSearchSchema } from '../router';
import type { Session } from '@dorkos/shared/types';
import { sessionKeys } from '@/layers/entities/session';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('sessionSearchSchema', () => {
  it('accepts a runtime launch param', () => {
    const parsed = sessionSearchSchema.parse({ runtime: 'opencode' });
    expect(parsed.runtime).toBe('opencode');
  });

  it('leaves runtime undefined when absent', () => {
    const parsed = sessionSearchSchema.parse({});
    expect(parsed.runtime).toBeUndefined();
  });
});

describe('sessionLoaderDeps', () => {
  it('declares exactly the params the loader acts on', () => {
    const search = sessionSearchSchema.parse({
      session: 'abc',
      dir: '/api',
      runtime: 'opencode',
      prompt: 'hello',
    });
    expect(sessionLoaderDeps({ search })).toEqual({
      session: 'abc',
      dir: '/api',
      runtime: 'opencode',
      prompt: 'hello',
    });
  });

  it('ignores dialog params, so opening a dialog cannot re-run session selection', () => {
    // `?settings=open` is a modifier on wherever you are. Including it here
    // would re-run the loader on every dialog toggle.
    const search = sessionSearchSchema.parse({ dir: '/api', settings: 'open' });
    expect(Object.keys(sessionLoaderDeps({ search })).sort()).toEqual([
      'dir',
      'prompt',
      'runtime',
      'session',
    ]);
  });
});

describe('sessionRouteLoader', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  /**
   * Invoke the loader the way the router does — through `loaderDeps`, so the
   * test exercises the same param extraction production uses — and catch the
   * redirect throw.
   */
  function callLoader(searchStr: string) {
    const search = sessionSearchSchema.parse(
      Object.fromEntries(new URLSearchParams(searchStr).entries())
    );
    try {
      sessionRouteLoader({
        context: { queryClient },
        deps: sessionLoaderDeps({ search }),
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
        runtime: 'claude-code',
      },
      {
        id: 'cached-s2',
        title: 'Second session',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T10:00:00Z',
        permissionMode: 'default',
        runtime: 'claude-code',
      },
    ];
    queryClient.setQueryData(sessionKeys.list(null), sessions);

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
        runtime: 'claude-code',
      },
    ];
    queryClient.setQueryData(sessionKeys.list('/my/project'), sessions);

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

  it('preserves runtime param when redirecting to cached session', () => {
    const sessions: Session[] = [
      {
        id: 's1',
        title: 'Session',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
        permissionMode: 'default',
        runtime: 'claude-code',
      },
    ];
    queryClient.setQueryData(sessionKeys.list(null), sessions);

    const result = callLoader('?runtime=opencode');
    expect(result.redirected).toBe(true);
    expect(result.redirect).toMatchObject({
      search: { session: 's1', runtime: 'opencode' },
    });
  });

  it('preserves runtime param when redirecting to new UUID', () => {
    const result = callLoader('?dir=/my/project&runtime=codex');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toMatch(UUID_REGEX);
    expect(search.dir).toBe('/my/project');
    expect(search.runtime).toBe('codex');
  });

  it('uses correct cache key with dir param', () => {
    // Sessions are cached per directory — dir=null when absent
    const sessionsForProject: Session[] = [
      {
        id: 'proj-s1',
        title: 'Project session',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
        permissionMode: 'default',
        runtime: 'claude-code',
      },
    ];
    // Put sessions under the wrong key (null instead of dir)
    queryClient.setQueryData(sessionKeys.list(null), sessionsForProject);

    // Loader should look under the '/my/project' list — will find nothing
    const result = callLoader('?dir=/my/project');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    // Should get a new UUID, not 'proj-s1', because the cache key didn't match
    expect(search.session).toMatch(UUID_REGEX);
    expect(search.session).not.toBe('proj-s1');
  });

  it('never auto-selects over an explicit fresh session id (Run this with… / ADR-0255)', () => {
    // A fresh session id (from "Run this with…") must survive even when sessions
    // ARE cached — the loader must NOT swap it for an existing one. This locks
    // the ADR-0255 invariant that a runtime switch is always a NEW session.
    const sessions: Session[] = [
      {
        id: 'cached-existing',
        title: 'Existing',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
        permissionMode: 'default',
        runtime: 'claude-code',
      },
    ];
    queryClient.setQueryData(sessionKeys.list(null), sessions);

    const result = callLoader(
      '?session=11111111-1111-4111-8111-111111111111&runtime=codex&prompt=hello'
    );
    // No redirect: the fresh id is preserved, never auto-selected onto 'cached-existing'.
    expect(result.redirected).toBe(false);
  });

  // This is what makes the model/effort picker usable BEFORE a session's first
  // message (spec `execution-defaults` §3.3). The status bar disables the picker
  // when it has no session id; in the cockpit it always has one, because every
  // path through this loader ends at a `/session` URL that carries one — the
  // most recent cached session, or a freshly minted UUID. Browser-verified on a
  // cold `/session?dir=…`: the picker opens, and the old "Send a message first"
  // tooltip never renders. Pinned here because it is the loader, not the status
  // bar, that holds the guarantee up — a change here would disable the picker
  // again with nothing in the picker's own tests to notice.
  it('never leaves /session without a session id — on either branch', () => {
    const fresh = callLoader('?dir=/api');
    expect(fresh.redirected).toBe(true);
    expect(
      ((fresh.redirect as Record<string, unknown>).search as Record<string, string>).session
    ).toMatch(UUID_REGEX);

    queryClient.setQueryData(sessionKeys.list(null), [
      {
        id: 'cached-s1',
        title: 'Existing',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
        permissionMode: 'default',
        runtime: 'claude-code',
      },
    ] satisfies Session[]);
    const existing = callLoader('');
    expect(existing.redirected).toBe(true);
    expect(
      ((existing.redirect as Record<string, unknown>).search as Record<string, string>).session
    ).toBe('cached-s1');
  });

  it('drops the prompt seed when auto-selecting an existing session', () => {
    // A prompt seed must only ride a FRESH session; auto-selecting an existing
    // one must drop it, so a seed can never land in an unintended session.
    const sessions: Session[] = [
      {
        id: 'cached-s1',
        title: 'Existing',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
        permissionMode: 'default',
        runtime: 'claude-code',
      },
    ];
    queryClient.setQueryData(sessionKeys.list(null), sessions);

    const result = callLoader('?prompt=hello&runtime=codex');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toBe('cached-s1');
    expect(search.runtime).toBe('codex');
    expect(search.prompt).toBeUndefined(); // dropped on auto-select
  });
});
