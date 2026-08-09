import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { sessionRouteLoader, sessionLoaderDeps, sessionSearchSchema } from '../router';
import type { Session } from '@dorkos/shared/types';
import { sessionKeys } from '@/layers/entities/session';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('sessionSearchSchema', () => {
  it('accepts a runtime launch param', async () => {
    const parsed = sessionSearchSchema.parse({ runtime: 'opencode' });
    expect(parsed.runtime).toBe('opencode');
  });

  it('leaves runtime undefined when absent', async () => {
    const parsed = sessionSearchSchema.parse({});
    expect(parsed.runtime).toBeUndefined();
  });
});

describe('sessionLoaderDeps', () => {
  it('declares exactly the params the loader acts on', async () => {
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

  it('ignores dialog params, so opening a dialog cannot re-run session selection', async () => {
    // `?settings=open` is a modifier on wherever you are. Including it here
    // would re-run the loader on every dialog toggle.
    const search = sessionSearchSchema.parse({ dir: '/api', settings: 'open' });
    expect(Object.keys(sessionLoaderDeps({ search })).sort()).toEqual([
      'dir',
      'prompt',
      'runtime',
      'send',
      'session',
    ]);
  });
});

describe('sessionRouteLoader', () => {
  let queryClient: QueryClient;
  let transport: Transport;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The server knows of no sessions unless a case says otherwise. Every
    // "no cached sessions" case below now goes through here: a cold cache is
    // no longer read as proof that a directory has no conversations (DOR-928).
    transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    }) as Transport;
  });

  /**
   * Invoke the loader the way the router does — through `loaderDeps`, so the
   * test exercises the same param extraction production uses — and catch the
   * redirect throw.
   */
  async function callLoader(searchStr: string) {
    const search = sessionSearchSchema.parse(
      Object.fromEntries(new URLSearchParams(searchStr).entries())
    );
    try {
      await sessionRouteLoader({
        context: { queryClient, transport },
        deps: sessionLoaderDeps({ search }),
      });
      return { redirected: false } as const;
    } catch (thrown: unknown) {
      // TanStack Router redirect() throws a Response-like object with an `options` property
      const opts = (thrown as { options: Record<string, unknown> }).options;
      return { redirected: true, redirect: opts };
    }
  }

  it('does not redirect when session param is already present', async () => {
    const result = await callLoader('?session=abc-123');
    expect(result.redirected).toBe(false);
  });

  it('redirects to cached session when sessions exist', async () => {
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

    const result = await callLoader('');
    expect(result.redirected).toBe(true);
    expect(result.redirect).toMatchObject({
      to: '/session',
      search: { session: 'cached-s1' },
      replace: true,
    });
  });

  it('redirects to new UUID when no cached sessions', async () => {
    const result = await callLoader('');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toMatch(UUID_REGEX);
    expect(result.redirect).toMatchObject({
      to: '/session',
      replace: true,
    });
  });

  it('preserves dir param when redirecting to cached session', async () => {
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

    const result = await callLoader('?dir=/my/project');
    expect(result.redirected).toBe(true);
    expect(result.redirect).toMatchObject({
      search: { session: 's1', dir: '/my/project' },
    });
  });

  it('preserves dir param when redirecting to new UUID', async () => {
    const result = await callLoader('?dir=/my/project');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toMatch(UUID_REGEX);
    expect(search.dir).toBe('/my/project');
  });

  it('preserves runtime param when redirecting to cached session', async () => {
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

    const result = await callLoader('?runtime=opencode');
    expect(result.redirected).toBe(true);
    expect(result.redirect).toMatchObject({
      search: { session: 's1', runtime: 'opencode' },
    });
  });

  it('preserves runtime param when redirecting to new UUID', async () => {
    const result = await callLoader('?dir=/my/project&runtime=codex');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toMatch(UUID_REGEX);
    expect(search.dir).toBe('/my/project');
    expect(search.runtime).toBe('codex');
  });

  it('uses correct cache key with dir param', async () => {
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

    // Loader should look under the '/my/project' list — will find nothing, and
    // the server (stubbed empty) has nothing to add
    const result = await callLoader('?dir=/my/project');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    // Should get a new UUID, not 'proj-s1', because the cache key didn't match
    expect(search.session).toMatch(UUID_REGEX);
    expect(search.session).not.toBe('proj-s1');
  });

  it('asks the server about a directory this window has never displayed', async () => {
    // The bug this loader used to have (DOR-928): an empty cache entry is the
    // NORMAL state for every agent but the one on screen, so treating it as
    // "no conversations" sent people to an empty chat. Red when the loader
    // decides from the cache alone — the redirect carries a minted UUID.
    transport.listSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          id: 'server-s1',
          title: 'Still running',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T12:00:00Z',
          permissionMode: 'default',
          runtime: 'claude-code',
        } satisfies Session,
      ],
    });

    const result = await callLoader('?dir=/never/opened');

    expect(result.redirect).toMatchObject({
      search: { session: 'server-s1', dir: '/never/opened' },
    });
    expect(transport.listSessions).toHaveBeenCalledWith('/never/opened');
  });

  it('raises rather than redirecting to a blank chat when it cannot ask', async () => {
    // There is no "stay put" for a loader: this URL IS where the person asked
    // to be. Redirecting to a minted id would show a blank chat for an agent
    // that may have work, which is the defect this path exists to remove — so
    // the route's error boundary is the honest answer (DOR-928).
    transport.listSessions = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(
      sessionRouteLoader({
        context: { queryClient, transport },
        deps: {
          dir: '/my/project',
          session: undefined,
          runtime: undefined,
          prompt: undefined,
          send: undefined,
        },
      })
    ).rejects.toThrow(/could ?n[o']t reach the server/i);
  });

  it('carries the prompt seed onto a genuinely fresh session', async () => {
    // The other half of the seed rule below: a seed is FOR a new conversation,
    // so the branch that starts one must keep it.
    const result = await callLoader('?dir=/my/project&prompt=hello');
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toMatch(UUID_REGEX);
    expect(search.prompt).toBe('hello');
  });

  it('never auto-selects over an explicit fresh session id (Run this with… / ADR-0255)', async () => {
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

    const result = await callLoader(
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
  it('never leaves /session without a session id — on either branch', async () => {
    const fresh = await callLoader('?dir=/api');
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
    const existing = await callLoader('');
    expect(existing.redirected).toBe(true);
    expect(
      ((existing.redirect as Record<string, unknown>).search as Record<string, string>).session
    ).toBe('cached-s1');
  });

  it('drops the prompt seed when auto-selecting an existing session', async () => {
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

    const result = await callLoader('?prompt=hello&runtime=codex');
    expect(result.redirected).toBe(true);
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toBe('cached-s1');
    expect(search.runtime).toBe('codex');
    expect(search.prompt).toBeUndefined(); // dropped on auto-select
  });

  it('carries the send opt-in onto a genuinely fresh session', async () => {
    const result = await callLoader('?dir=/my/project&prompt=hello&send=1');
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.prompt).toBe('hello');
    expect(search.send).toBe('1');
  });

  it('drops the send opt-in when auto-selecting an existing session', async () => {
    // The strictest version of the seed rule. A seed that must not RIDE an
    // existing conversation must certainly not start a turn on one, so the
    // opt-in is dropped by the same branch and for the same reason.
    queryClient.setQueryData(sessionKeys.list(null), [
      {
        id: 'cached-s1',
        title: 'Existing',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
        permissionMode: 'default',
        runtime: 'claude-code',
      } satisfies Session,
    ]);

    const result = await callLoader('?prompt=hello&send=1');
    const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
    expect(search.session).toBe('cached-s1');
    expect(search.prompt).toBeUndefined();
    expect(search.send).toBeUndefined();
  });

  it('ignores a send value that is not the exact opt-in', async () => {
    // `.catch(undefined)` on the literal: `?send=0` reads as "no", not as a
    // parse error that would blank the route — and nothing but `1` can ever
    // start a turn on somebody's behalf.
    for (const raw of ['0', 'true', 'yes', '']) {
      const result = await callLoader(`?dir=/my/project&prompt=hello&send=${raw}`);
      const search = (result.redirect as Record<string, unknown>).search as Record<string, string>;
      expect(search.prompt).toBe('hello');
      expect(search.send).toBeUndefined();
    }
  });
});
