/**
 * @vitest-environment jsdom
 *
 * Which directory a session's own reads are scoped to (DOR-1444).
 *
 * The bug this pins is a race that resolves the WRONG way. A session URL
 * without `&dir=` used to bind correctly for about one render — nothing had
 * named a directory, so the stream attached without one and the server resolved
 * the session's real directory itself — and then `useDefaultCwd` filled
 * `selectedCwd` with the SERVER's default, every session-scoped consumer
 * re-keyed on it, and the window went back to reading a directory the session
 * is not in. On the machine where this was found that directory was outside the
 * boundary, so the re-attach was refused and the status line read "Live updates
 * lost" while the first window was streaming.
 *
 * The store filling in is not an error state — it is the ordinary startup path,
 * and `selectedCwd` is the right answer for the question it actually answers
 * ("where would new work happen"). It is just not this question.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const urlSearch: { dir?: string } = {};
let embedded = false;

vi.mock('@/layers/shared/lib', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/lib');
  return { ...actual, getPlatform: () => ({ isEmbedded: embedded }) };
});

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return { ...actual, useSafeSearch: () => urlSearch };
});

import { useAppStore } from '@/layers/shared/model';
import { useSessionScopedCwd, isSessionScopeReady } from '../use-session-scoped-cwd';

beforeEach(() => {
  delete urlSearch.dir;
  embedded = false;
  useAppStore.setState({ selectedCwd: null });
});

describe('useSessionScopedCwd', () => {
  it('names the directory the URL named', () => {
    urlSearch.dir = '/projects/api';

    const { result } = renderHook(() => useSessionScopedCwd());

    expect(result.current).toEqual({ cwd: '/projects/api', resolved: true });
  });

  it('stays null when the URL named none, even after the store fills with the default', () => {
    const { result } = renderHook(() => useSessionScopedCwd());

    expect(result.current).toEqual({ cwd: null, resolved: true });

    // The startup fetch lands. Red when this hook reads `selectedCwd`: the
    // session's reads silently re-point at the server default, which is the
    // wrong project for any session that lives elsewhere.
    act(() => {
      useAppStore.setState({ selectedCwd: '/server/default' });
    });

    expect(result.current.cwd).toBeNull();
  });

  it('is answerable from the first render, so no query re-keys underneath itself', () => {
    // Why the standalone answer is always `resolved`: it comes from the URL,
    // which is present before the first paint. A consumer that fires on it
    // fires exactly once — the double-fetch DOR-495 removed cannot come back
    // through this door.
    urlSearch.dir = '/projects/api';

    const { result, rerender } = renderHook(() => useSessionScopedCwd());
    const first = result.current;
    rerender();

    expect(result.current).toEqual(first);
    expect(isSessionScopeReady('s1', result.current)).toBe(true);
  });

  describe('embedded (Obsidian), where there is no URL', () => {
    beforeEach(() => {
      embedded = true;
    });

    it('reads the store, and reports itself unsettled until the store answers', () => {
      const { result } = renderHook(() => useSessionScopedCwd());

      expect(result.current).toEqual({ cwd: null, resolved: false });
      expect(isSessionScopeReady('s1', result.current)).toBe(false);

      act(() => {
        useAppStore.setState({ selectedCwd: '/vault/notes' });
      });

      expect(result.current).toEqual({ cwd: '/vault/notes', resolved: true });
      expect(isSessionScopeReady('s1', result.current)).toBe(true);
    });
  });

  it('is never ready without a session, whatever the directory says', () => {
    urlSearch.dir = '/projects/api';

    const { result } = renderHook(() => useSessionScopedCwd());

    expect(isSessionScopeReady(null, result.current)).toBe(false);
  });
});
