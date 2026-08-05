import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock platform
let mockIsEmbedded = false;
vi.mock('@/layers/shared/lib/platform', () => ({
  getPlatform: () => ({ isEmbedded: mockIsEmbedded }),
}));

// Mock app store
let mockStoreDir: string | null = null;
const mockSetStoreDir = vi.fn((dir: string | null) => {
  mockStoreDir = dir;
});
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      selectedCwd: mockStoreDir,
      setSelectedCwd: mockSetStoreDir,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock useSessionId
const mockSetSessionId = vi.fn();
vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => [null, mockSetSessionId] as const,
}));

// Mock useSessionSearch (TanStack Router search params)
let mockSearchDir: string | undefined = undefined;
vi.mock('@/layers/entities/session/model/use-session-search', () => ({
  useSessionSearch: () => ({ dir: mockSearchDir }),
}));

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// The hook resolves which session a directory opens on, which asks the server
// whenever this window has nothing cached for it (DOR-928).
const mockListSessions = vi.fn(
  (): Promise<{ sessions: { id: string }[] }> => Promise.resolve({ sessions: [] })
);
vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: () => ({ listSessions: mockListSessions }),
}));

// A REAL QueryClient behind `useQueryClient`, not a two-method stub: resolving
// a directory's session writes through the same caches the app writes, and a
// stub that throws inside the fetch is indistinguishable from a server that has
// no sessions — which is the very confusion this hook stopped making.
let queryClient: import('@tanstack/react-query').QueryClient;
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => queryClient,
}));

import { QueryClient } from '@tanstack/react-query';
import { useDirectoryState } from '../model/use-directory-state';

describe('useDirectoryState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEmbedded = false;
    mockStoreDir = null;
    mockSearchDir = undefined;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('returns URL state in standalone mode', () => {
    mockSearchDir = '/test/path';
    const { result } = renderHook(() => useDirectoryState());
    expect(result.current[0]).toBe('/test/path');
  });

  it('returns Zustand state in embedded mode', () => {
    mockIsEmbedded = true;
    mockStoreDir = '/embedded/path';
    const { result } = renderHook(() => useDirectoryState());
    expect(result.current[0]).toBe('/embedded/path');
  });

  it('setter calls navigate and updates Zustand in standalone', async () => {
    const { result } = renderHook(() => useDirectoryState());
    act(() => {
      result.current[1]('/new/path');
    });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '/session',
          search: expect.objectContaining({ dir: '/new/path' }),
        })
      )
    );
    expect(mockSetStoreDir).toHaveBeenCalledWith('/new/path');
  });

  it('setter includes session param in navigate on directory change', async () => {
    const { result } = renderHook(() => useDirectoryState());
    act(() => {
      result.current[1]('/any/path');
    });
    // In standalone mode, session ID is included in the navigate call
    // (not cleared separately) to prevent null-session state.
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({
          search: expect.objectContaining({ dir: '/any/path', session: expect.any(String) }),
        })
      )
    );
    expect(mockSetSessionId).not.toHaveBeenCalled();
  });

  it('setting null removes ?dir= from URL via navigate', async () => {
    mockSearchDir = '/existing/path';
    const { result } = renderHook(() => useDirectoryState());
    act(() => {
      result.current[1](null);
    });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({
          search: expect.any(Function),
        })
      )
    );
  });

  it('falls back to Zustand when URL has no ?dir= param', () => {
    mockSearchDir = undefined;
    mockStoreDir = '/default/path';
    const { result } = renderHook(() => useDirectoryState());
    expect(result.current[0]).toBe('/default/path');
  });

  it('preserveSession: true skips session clearing in standalone', async () => {
    const { result } = renderHook(() => useDirectoryState());
    act(() => {
      result.current[1]('/new/path', { preserveSession: true });
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockSetStoreDir).toHaveBeenCalledWith('/new/path');
    expect(mockSetSessionId).not.toHaveBeenCalled();
  });

  it('opens the directory’s real session, asking the server when nothing is cached', async () => {
    // The reported bug at this seam: a directory this window has never
    // displayed has an empty cache entry, which used to be read as "no
    // conversations" and opened an empty chat instead (DOR-928).
    mockListSessions.mockResolvedValueOnce({ sessions: [{ id: 'sess-on-server' }] });
    const { result } = renderHook(() => useDirectoryState());
    act(() => {
      result.current[1]('/never/opened');
    });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/session',
        search: { dir: '/never/opened', session: 'sess-on-server' },
      })
    );
  });

  it('preserveSession: true skips session clearing in embedded', () => {
    mockIsEmbedded = true;
    const { result } = renderHook(() => useDirectoryState());
    act(() => {
      result.current[1]('/new/path', { preserveSession: true });
    });
    expect(mockSetStoreDir).toHaveBeenCalledWith('/new/path');
    expect(mockSetSessionId).not.toHaveBeenCalled();
  });
});
