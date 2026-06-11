// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';

// Stub the StreamManager so the hook's `connectList()` never opens a real fetch
// in jsdom. The binding stays real (it only wires listeners), and we drive the
// list store directly via `applyListEvent` to simulate global-stream frames.
vi.mock('@/layers/shared/lib/transport', () => ({
  streamManager: {
    connectList: vi.fn(),
    setListeners: vi.fn(),
    attachSession: vi.fn(),
    getAttachedSessionId: vi.fn().mockReturnValue(null),
    subscribeListConnectionState: vi.fn().mockReturnValue(() => {}),
  },
}));

import { useSessionListStore } from '../session-list-store';
import { resetSessionStreamBinding } from '../session-stream-binding';
import { reconcileSessionsCache, useGlobalSessionStream } from '../use-global-session-stream';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Session 1',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    permissionMode: 'default',
    cwd: '/test/cwd',
    ...overrides,
  };
}

describe('reconcileSessionsCache', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('upserts a new session into its cwd-keyed cache and only that key', () => {
    const s = session();
    reconcileSessionsCache(queryClient, { s1: s }, {});

    expect(queryClient.getQueryData<Session[]>(['sessions', '/test/cwd'])).toEqual([s]);
    // A different cwd key is untouched.
    expect(queryClient.getQueryData(['sessions', '/other'])).toBeUndefined();
  });

  it('updates an existing session by id without duplicating it', () => {
    const s = session();
    reconcileSessionsCache(queryClient, { s1: s }, {});
    const updated = session({ title: 'Renamed' });
    reconcileSessionsCache(queryClient, { s1: updated }, { s1: s });

    const list = queryClient.getQueryData<Session[]>(['sessions', '/test/cwd'])!;
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Renamed');
  });

  it('removes a session present in prev but absent in next', () => {
    const s = session();
    reconcileSessionsCache(queryClient, { s1: s }, {});
    reconcileSessionsCache(queryClient, {}, { s1: s });

    expect(queryClient.getQueryData<Session[]>(['sessions', '/test/cwd'])).toEqual([]);
  });

  it('skips an entry whose object reference is unchanged (idempotent)', () => {
    const s = session();
    reconcileSessionsCache(queryClient, { s1: s }, {});
    const before = queryClient.getQueryData<Session[]>(['sessions', '/test/cwd']);

    // Same reference in next and prev → the loop short-circuits, no re-add.
    reconcileSessionsCache(queryClient, { s1: s }, { s1: s });
    const after = queryClient.getQueryData<Session[]>(['sessions', '/test/cwd']);

    expect(after).toBe(before); // cache array reference untouched
    expect(after).toHaveLength(1); // no duplicate
  });

  it('keeps the list sorted most-recent-first by updatedAt', () => {
    const older = session({ id: 'a', updatedAt: '2026-06-09T00:00:00.000Z' });
    const newer = session({ id: 'b', updatedAt: '2026-06-10T00:00:00.000Z' });
    // Insert older first, then newer — sort must reorder newer to the front.
    reconcileSessionsCache(queryClient, { a: older }, {});
    reconcileSessionsCache(queryClient, { a: older, b: newer }, { a: older });

    const list = queryClient.getQueryData<Session[]>(['sessions', '/test/cwd'])!;
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('useGlobalSessionStream', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useSessionListStore.setState({ sessions: {}, statuses: {} });
    resetSessionStreamBinding();
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  // Regression for the connect-before-subscribe event-loss window: a frame that
  // already landed in the store BEFORE the hook mounts must still reach the cache,
  // because the hook reconciles current state after subscribing (subscribe →
  // reconcile-current → connect). If the order were connect-first or the seed were
  // skipped, this pre-existing session would never reach the cache.
  it('reconciles sessions already present in the store at mount time', () => {
    useSessionListStore.getState().applyListEvent({ type: 'session_upserted', session: session() });
    // Cache is empty until the hook mounts and reconciles the existing store state.
    expect(queryClient.getQueryData(['sessions', '/test/cwd'])).toBeUndefined();

    renderHook(() => useGlobalSessionStream(), { wrapper });

    expect(queryClient.getQueryData<Session[]>(['sessions', '/test/cwd'])).toEqual([session()]);
  });

  it('reflects live global-stream session_upserted / session_removed into the cache', () => {
    renderHook(() => useGlobalSessionStream(), { wrapper });

    // A session surfaced on the global stream lands in its cwd-keyed cache.
    act(() => {
      useSessionListStore
        .getState()
        .applyListEvent({ type: 'session_upserted', session: session() });
    });
    expect(queryClient.getQueryData<Session[]>(['sessions', '/test/cwd'])).toEqual([session()]);

    // Removing it on the stream drops it from the cache.
    act(() => {
      useSessionListStore.getState().applyListEvent({ type: 'session_removed', sessionId: 's1' });
    });
    expect(queryClient.getQueryData<Session[]>(['sessions', '/test/cwd'])).toEqual([]);
  });

  it('surfaces an externally-created session (e.g. Claude Code CLI) live, without polling', () => {
    renderHook(() => useGlobalSessionStream(), { wrapper });

    const external = session({ id: 'cli-1', title: 'CLI session' });
    act(() => {
      useSessionListStore
        .getState()
        .applyListEvent({ type: 'session_upserted', session: external });
    });

    const list = queryClient.getQueryData<Session[]>(['sessions', '/test/cwd'])!;
    expect(list.map((s) => s.id)).toContain('cli-1');
  });
});
