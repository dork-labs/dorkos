// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { renderHook, act, waitFor } from '@testing-library/react';

let mockStoreDir: string | null = null;
const mockSetStoreDir = vi.fn();
const mockSetPendingRuntime = vi.fn();

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      selectedCwd: mockStoreDir,
      setSelectedCwd: mockSetStoreDir,
      setSessionId: mockSetSessionId,
      setPendingRuntime: mockSetPendingRuntime,
    };
    return selector ? selector(state) : state;
  },
}));

const mockRouter = {
  state: { location: { pathname: '/session', search: { session: 'original' } } },
};

const mockSetSessionId = vi.fn();
vi.mock('@/layers/entities/session/model/navigation/use-session-search', () => ({
  useSessionSearch: () => ({}),
}));

const mockNavigate = vi.fn((_opts: { to: string; search: Record<string, unknown> }) => {});
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
  useRouter: () => mockRouter,
}));

import { useStartNewSession } from '../model/navigation/use-session-id';

const transport = createMockTransport();
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <TransportProvider transport={transport}>{children}</TransportProvider>
);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('useStartNewSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreDir = null;
    mockRouter.state.location = { pathname: '/session', search: { session: 'original' } };
  });

  it('opens a brand-new conversation on the named agent', async () => {
    const { result } = renderHook(() => useStartNewSession(), { wrapper });
    await act(async () => {
      await result.current('/projects/beta');
    });

    expect(transport.createSessionLocation).toHaveBeenCalledWith(mockStoreDir ?? '/projects/beta');
    expect(transport.allocateSession).toHaveBeenCalledWith({
      kind: 'location',
      launchRef: 'test-location',
    });
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: expect.objectContaining({
        launchRef: 'test-location',
        draft: '1',
        session: expect.stringMatching(UUID),
      }),
    });
  });

  it('mints a different id every time — otherwise it is not new', async () => {
    const { result } = renderHook(() => useStartNewSession(), { wrapper });
    await act(async () => {
      await result.current('/projects/beta');
    });
    await act(async () => {
      await result.current('/projects/beta');
    });

    const ids = mockNavigate.mock.calls.map((c) => c[0].search.session);
    expect(new Set(ids).size).toBe(2);
  });

  it('shares a pending start and records runtime intent only under its acknowledged id', async () => {
    const acknowledgement = deferred<{ sessionId: string }>();
    vi.mocked(transport.allocateSession).mockReturnValueOnce(acknowledgement.promise);
    const { result } = renderHook(() => useStartNewSession(), { wrapper });
    act(() => {
      result.current('/projects/same', { runtime: 'codex' });
      result.current('/projects/same', { runtime: 'codex' });
    });
    await waitFor(() => expect(transport.allocateSession).toHaveBeenCalledTimes(1));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSetPendingRuntime).not.toHaveBeenCalled();

    await act(async () => {
      acknowledgement.resolve({ sessionId: 'acknowledged-session' });
    });
    expect(mockSetPendingRuntime).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'acknowledged-session',
      type: 'codex',
    });
    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith({
      to: '/session',
      search: expect.objectContaining({ session: 'acknowledged-session', runtime: 'codex' }),
    });
  });

  it('keeps distinct actions in the same folder separate and opens only the latest wanted one', async () => {
    const first = deferred<{ sessionId: string }>();
    const second = deferred<{ sessionId: string }>();
    vi.mocked(transport.allocateSession)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useStartNewSession(), { wrapper });
    act(() => result.current('/same', { prompt: 'First', runtime: 'opencode' }));
    await waitFor(() => expect(transport.allocateSession).toHaveBeenCalledTimes(1));
    act(() => result.current('/same', { prompt: 'Second', runtime: 'codex' }));
    await waitFor(() => expect(transport.allocateSession).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve({ sessionId: 'second-chat' });
      first.resolve({ sessionId: 'first-chat' });
    });

    expect(mockSetPendingRuntime).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'second-chat',
      type: 'codex',
    });
    expect(mockNavigate).toHaveBeenCalledExactlyOnceWith({
      to: '/session',
      search: expect.objectContaining({ session: 'second-chat', prompt: 'Second' }),
    });
  });

  it('leaves a late acknowledgement inert after another route opens', async () => {
    const acknowledgement = deferred<{ sessionId: string }>();
    vi.mocked(transport.allocateSession).mockReturnValueOnce(acknowledgement.promise);
    const { result } = renderHook(() => useStartNewSession(), { wrapper });
    act(() => result.current('/projects/original', { runtime: 'codex' }));
    await waitFor(() => expect(transport.allocateSession).toHaveBeenCalledTimes(1));
    mockRouter.state.location = { pathname: '/session', search: { session: 'other-chat' } };
    await act(async () => {
      acknowledgement.resolve({ sessionId: 'late-session' });
    });
    expect(mockSetPendingRuntime).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('falls back to the active agent when none is named', async () => {
    mockStoreDir = '/projects/current';
    const { result } = renderHook(() => useStartNewSession(), { wrapper });
    await act(async () => {
      await result.current();
    });

    expect(transport.createSessionLocation).toHaveBeenCalledWith(mockStoreDir ?? '/projects/beta');
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: expect.objectContaining({
        launchRef: 'test-location',
        draft: '1',
        session: expect.stringMatching(UUID),
      }),
    });
  });
});
