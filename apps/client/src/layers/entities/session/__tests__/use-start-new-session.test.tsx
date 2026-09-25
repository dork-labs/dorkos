// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let mockStoreDir: string | null = null;
const mockSetStoreDir = vi.fn();

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

const mockNavigate = vi.fn((_opts: { to: string; search: Record<string, unknown> }) => {});
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

import { useStartNewSession } from '../model/navigation/use-session-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('useStartNewSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
