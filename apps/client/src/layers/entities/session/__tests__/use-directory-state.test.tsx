import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

// Mock useNavigate. Navigating MOVES the location, as it does in the app: what
// stops an overtaken lookup from landing is the router's own location having
// changed, so a location that never moves would test nothing.
let mockLocation: { pathname: string; search: Record<string, unknown> } = {
  pathname: '/session',
  search: {},
};
const mockNavigate = vi.fn((opts: { to?: string; search?: unknown }) => {
  const next =
    typeof opts.search === 'function'
      ? (opts.search as (p: Record<string, unknown>) => Record<string, unknown>)(
          mockLocation.search
        )
      : ((opts.search as Record<string, unknown>) ?? {});
  mockLocation = { pathname: opts.to ?? mockLocation.pathname, search: next };
});
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({
    state: {
      get location() {
        return mockLocation;
      },
    },
  }),
}));

// The hook resolves which session a directory opens on, which asks the server
// whenever this window has nothing cached for it (DOR-928).
const mockListSessions = vi.fn((): Promise<{ sessions: { id: string }[] }> =>
  Promise.resolve({ sessions: [] })
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
    mockLocation = { pathname: '/session', search: {} };
    vi.mocked(toast.error).mockReset();
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

  it('says the lookup failed, moves nothing, and never reports it opened', async () => {
    // This is the command palette's agent-select path. A failed lookup that
    // quietly minted a session would open a blank chat for an agent that has
    // work — DOR-928's own symptom — and `onOpened` firing anyway would have the
    // palette rank an agent you never reached.
    mockListSessions.mockRejectedValueOnce(new Error('offline'));
    const onOpened = vi.fn();
    const { result } = renderHook(() => useDirectoryState());

    await act(async () => {
      result.current[1]('/never/opened', { onOpened });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onOpened).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSetStoreDir).not.toHaveBeenCalled();
  });

  it('commits the directory only once it knows which conversation to open', async () => {
    // The chat stream is keyed on (session id, selected cwd). Committing the
    // new directory while the lookup is still out pairs it with the OLD session
    // id, and the server resolves a transcript from `?cwd=`.
    let answer!: (value: { sessions: { id: string }[] }) => void;
    mockListSessions.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const { result } = renderHook(() => useDirectoryState());

    act(() => {
      result.current[1]('/never/opened');
    });
    expect(mockSetStoreDir).not.toHaveBeenCalled();

    await act(async () => {
      answer({ sessions: [{ id: 'sess-1' }] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockSetStoreDir).toHaveBeenCalledWith('/never/opened');
  });

  it('stays quiet and still when something else navigated while it waited', async () => {
    // No cooperation required from whatever navigated: the router's location
    // moved, which is the signal. An abandoned switch must not move you AND
    // must not explain itself — you are somewhere else now.
    let answer!: (value: { sessions: { id: string }[] }) => void;
    mockListSessions.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const { result } = renderHook(() => useDirectoryState());

    const onOpened = vi.fn();
    act(() => {
      result.current[1]('/never/opened', { onOpened });
    });
    mockLocation = { pathname: '/channels', search: { id: 'c1' } }; // opened a channel

    await act(async () => {
      answer({ sessions: [{ id: 'sess-1' }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onOpened).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSetStoreDir).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stays silent about a failure the person has already navigated away from', async () => {
    // "We left you where you are" is only true if they are still there. An
    // abandoned lookup that also fails must say nothing at all — checking
    // overtaken-ness BEFORE the failure branch is what makes that so.
    let reject!: (reason: Error) => void;
    mockListSessions.mockReturnValueOnce(
      new Promise((_resolve, rej) => {
        reject = rej;
      })
    );
    const { result } = renderHook(() => useDirectoryState());

    act(() => {
      void result.current[1]('/never/opened');
    });
    mockLocation = { pathname: '/channels', search: { id: 'c1' } }; // they moved on

    await act(async () => {
      reject(new Error('offline'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('reports that the agent opened, on the web path', async () => {
    // Every other `onOpened` case here is a negative. This is the one that says
    // it fires at all — and the palette's frecency and "switch back" ride it, so
    // if it stopped firing both would go quiet with nothing failing.
    mockListSessions.mockResolvedValueOnce({ sessions: [{ id: 'sess-1' }] });
    const onOpened = vi.fn();
    const { result } = renderHook(() => useDirectoryState());

    await act(async () => {
      result.current[1]('/never/opened', { onOpened });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalled();
  });

  it('reports that the agent opened, on the embedded path too', () => {
    // Obsidian has no router, so this branch never awaits anything — and it is
    // the branch a web-only test would silently skip.
    mockIsEmbedded = true;
    const onOpened = vi.fn();
    const { result } = renderHook(() => useDirectoryState());

    act(() => {
      result.current[1]('/embedded/path', { onOpened });
    });

    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(mockSetStoreDir).toHaveBeenCalledWith('/embedded/path');
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
