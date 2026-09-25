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

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return { ...actual, useSafeSearch: () => urlSearch };
});

import { useAppStore } from '@/layers/shared/model';
import { useSessionScopedCwd } from '../use-session-scoped-cwd';

beforeEach(() => {
  delete urlSearch.dir;
  useAppStore.setState({ selectedCwd: null });
});

describe('useSessionScopedCwd', () => {
  it('names the directory the URL named', () => {
    urlSearch.dir = '/projects/api';

    const { result } = renderHook(() => useSessionScopedCwd());

    expect(result.current).toEqual({ cwd: '/projects/api' });
  });

  it('stays null when the URL named none, even after the store fills with the default', () => {
    const { result } = renderHook(() => useSessionScopedCwd());

    expect(result.current).toEqual({ cwd: null });

    // The startup fetch lands. Red when this hook reads `selectedCwd`: the
    // session's reads silently re-point at the server default, which is the
    // wrong project for any session that lives elsewhere.
    act(() => {
      useAppStore.setState({ selectedCwd: '/server/default' });
    });

    expect(result.current.cwd).toBeNull();
  });

  it('is answerable from the first render, so no query re-keys underneath itself', () => {
    // The directory comes from the URL,
    // which is present before the first paint. A consumer that fires on it
    // fires exactly once — the double-fetch DOR-495 removed cannot come back
    // through this door.
    urlSearch.dir = '/projects/api';

    const { result, rerender } = renderHook(() => useSessionScopedCwd());
    const first = result.current;
    rerender();

    expect(result.current).toEqual(first);
  });
});
