// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let mockIsEmbedded = false;
vi.mock('@/layers/shared/lib/platform', () => ({
  getPlatform: () => ({ isEmbedded: mockIsEmbedded }),
}));

let mockStoreDir: string | null = null;
const mockSetStoreDir = vi.fn((dir: string) => {
  mockStoreDir = dir;
});
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      selectedCwd: mockStoreDir,
      setSelectedCwd: mockSetStoreDir,
      setSessionId: mockSetSessionId,
    };
    return selector ? selector(state) : state;
  },
}));

const mockSetSessionId = vi.fn();
vi.mock('@/layers/entities/session/model/navigation/use-session-search', () => ({
  useSessionSearch: () => ({}),
}));

// In the real embed `useNavigate()` returns a function that THROWS when called.
// Modelled exactly, because the whole point of this hook is that it never calls
// it there.
const mockNavigate = vi.fn((_opts: { to: string; search: Record<string, unknown> }) => {
  if (mockIsEmbedded) throw new TypeError("Cannot read properties of null (reading 'navigate')");
});
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

import { useStartNewSession } from '../model/navigation/use-session-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('useStartNewSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEmbedded = false;
    mockStoreDir = null;
  });

  it('opens a brand-new conversation on the named agent', () => {
    const { result } = renderHook(() => useStartNewSession());
    act(() => result.current('/projects/beta'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/projects/beta', session: expect.stringMatching(UUID) },
    });
  });

  it('mints a different id every time — otherwise it is not new', () => {
    const { result } = renderHook(() => useStartNewSession());
    act(() => result.current('/projects/beta'));
    act(() => result.current('/projects/beta'));

    const ids = mockNavigate.mock.calls.map((c) => c[0].search.session);
    expect(new Set(ids).size).toBe(2);
  });

  it('falls back to the active agent when none is named', () => {
    mockStoreDir = '/projects/current';
    const { result } = renderHook(() => useStartNewSession());
    act(() => result.current());

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/projects/current', session: expect.stringMatching(UUID) },
    });
  });

  it('works in the embed, where calling the navigator would throw', () => {
    // Obsidian renders the palette and the chat header with no RouterProvider,
    // so `useNavigate`'s returned function throws when called. Each surface used
    // to call it directly — and it threw BEFORE the work that follows, leaving
    // the palette open on a click that did nothing (DOR-928 review).
    mockIsEmbedded = true;
    const { result } = renderHook(() => useStartNewSession());

    expect(() => act(() => result.current('/embedded/agent'))).not.toThrow();
    expect(mockSetStoreDir).toHaveBeenCalledWith('/embedded/agent');
    expect(mockSetSessionId).toHaveBeenCalledWith(expect.stringMatching(UUID));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
