/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useSessionStatus } from '../model/use-session-status';
import { useSessionSettingsOverridesStore } from '../model/session-settings-overrides';

// Mock app store (selectedCwd)
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: vi.fn((selector: (s: { selectedCwd: string | null }) => unknown) =>
    selector({ selectedCwd: null })
  ),
}));

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useSessionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Optimism is a module-level store now (so every reader of a session agrees);
    // reset it so one test's pending change cannot bleed into the next.
    useSessionSettingsOverridesStore.setState({ bySession: {} });
  });

  // Unmount between tests: the overrides store is module-level, so a hook left
  // mounted from an earlier test would keep running its convergence effect
  // against a different test's query cache.
  afterEach(cleanup);

  it('shows a second reader of the same session the optimistic change immediately', async () => {
    // The reason the overrides are shared rather than per-instance: the status
    // line's permission item and the strip above it are two `useSessionStatus`
    // instances, and they used to disagree for a whole PATCH round-trip.
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({ id: 's1', model: 'a', permissionMode: 'default' }),
      updateSession: vi.fn().mockResolvedValue({ permissionMode: 'plan' }),
    });
    const wrapper = createWrapper(transport);

    const writer = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    const reader = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    await waitFor(() => expect(reader.result.current.permissionMode).toBe('default'));

    await act(async () => {
      writer.result.current.updateSession({ permissionMode: 'plan' });
    });

    expect(reader.result.current.permissionMode).toBe('plan');
  });

  it("keeps one session's optimism out of another session", async () => {
    const transport = createMockTransport({
      getSession: vi.fn(
        async (id: string) => ({ id, model: 'a', permissionMode: 'default' }) as never
      ),
      updateSession: vi.fn().mockResolvedValue({ permissionMode: 'plan' }),
    });
    const wrapper = createWrapper(transport);

    const first = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    const other = renderHook(() => useSessionStatus('s2', null, false), { wrapper });
    await waitFor(() => expect(other.result.current.permissionMode).toBe('default'));

    await act(async () => {
      first.result.current.updateSession({ permissionMode: 'plan' });
    });

    expect(first.result.current.permissionMode).toBe('plan');
    expect(other.result.current.permissionMode).toBe('default');
  });

  it('holds optimistic model until server confirms via query cache', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
      updateSession: vi.fn().mockResolvedValue({
        model: 'claude-haiku-4-5-20251001',
      }),
    });

    const { result } = renderHook(() => useSessionStatus('s1', null, false), {
      wrapper: createWrapper(transport),
    });

    // Wait for initial session query
    await waitFor(() => {
      expect(result.current.model).toBe('claude-sonnet-4-5-20250929');
    });

    // Trigger model change
    await act(async () => {
      result.current.updateSession({ model: 'claude-haiku-4-5-20251001' });
    });

    // Optimistic: should immediately show haiku
    expect(result.current.model).toBe('claude-haiku-4-5-20251001');

    // After PATCH resolves and convergence effect fires, should still show haiku
    await waitFor(() => {
      expect(result.current.model).toBe('claude-haiku-4-5-20251001');
    });
  });

  it('reverts optimistic model on PATCH failure', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
      updateSession: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const { result } = renderHook(() => useSessionStatus('s1', null, false), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.model).toBe('claude-sonnet-4-5-20250929');
    });

    // Trigger model change — PATCH will fail
    await act(async () => {
      result.current.updateSession({ model: 'claude-haiku-4-5-20251001' });
    });

    // After PATCH fails: reverts to sonnet (catch path clears optimistic state)
    await waitFor(() => {
      expect(result.current.model).toBe('claude-sonnet-4-5-20250929');
    });
  });

  it("a failed PATCH does not revert a later writer's pending value", async () => {
    // Two surfaces now share one optimism store, so a rollback has to be
    // value-scoped. Key-scoped, this sequence snapped every reader back to the
    // server's model while B's request was still in flight: A sets X, B sets Y, A
    // rejects, A's catch drops the `model` key — including B's value.
    let rejectA: (err: Error) => void = () => {};
    const transport = createMockTransport({
      getSession: vi
        .fn()
        .mockResolvedValue({ id: 's1', model: 'server', permissionMode: 'default' }),
      updateSession: vi
        .fn()
        // A: never settles until we say so.
        .mockImplementationOnce(() => new Promise((_, reject) => (rejectA = reject)))
        // B: also in flight, and still in flight when A fails.
        .mockImplementationOnce(() => new Promise(() => {})),
    });
    const wrapper = createWrapper(transport);

    const a = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    const b = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    await waitFor(() => expect(b.result.current.model).toBe('server'));

    await act(async () => {
      void a.result.current.updateSession({ model: 'X' });
    });
    expect(b.result.current.model).toBe('X');

    await act(async () => {
      void b.result.current.updateSession({ model: 'Y' });
    });
    expect(a.result.current.model).toBe('Y');

    // A now fails. Its own value is long gone — the key belongs to B.
    await act(async () => {
      rejectA(new Error('Network error'));
      await Promise.resolve();
    });

    expect(a.result.current.model).toBe('Y');
    expect(b.result.current.model).toBe('Y');
  });

  it('still reverts its own value when nothing newer is pending', async () => {
    const transport = createMockTransport({
      getSession: vi
        .fn()
        .mockResolvedValue({ id: 's1', model: 'server', permissionMode: 'default' }),
      updateSession: vi.fn().mockRejectedValue(new Error('Network error')),
    });
    const wrapper = createWrapper(transport);

    const a = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    const b = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    await waitFor(() => expect(b.result.current.model).toBe('server'));

    await act(async () => {
      await a.result.current.updateSession({ model: 'X' });
    });

    // Both readers roll back together — the point of sharing the store.
    expect(a.result.current.model).toBe('server');
    expect(b.result.current.model).toBe('server');
  });

  it('applies convergence to permissionMode consistently', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
      updateSession: vi.fn().mockResolvedValue({
        permissionMode: 'plan',
      }),
    });

    const { result } = renderHook(() => useSessionStatus('s1', null, false), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.permissionMode).toBe('default');
    });

    // Trigger permissionMode change
    await act(async () => {
      result.current.updateSession({ permissionMode: 'plan' });
    });

    // Optimistic: should immediately show 'plan'
    expect(result.current.permissionMode).toBe('plan');

    // After convergence, should still show 'plan'
    await waitFor(() => {
      expect(result.current.permissionMode).toBe('plan');
    });
  });

  it('does not use streamingStatus.model when isStreaming is false', async () => {
    // Purpose: Regression for Bug #3 — after a stream, the stale streamingStatus.model
    // must not override session.model, so model changes via PATCH are reflected immediately.
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-haiku-4-5-20251001',
        permissionMode: 'default',
      }),
    });

    const streamingStatus = { model: 'claude-sonnet-4-6' } as SessionStatusEvent;

    const { result } = renderHook(() => useSessionStatus('s1', streamingStatus, false), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      // session?.model should win; streamingStatus.model must NOT override it
      expect(result.current.model).toBe('claude-haiku-4-5-20251001');
    });
  });

  it('uses streamingStatus.model while isStreaming is true', async () => {
    // Purpose: Verify the fix does not break live-streaming display of model name.
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
    });

    const streamingStatus = { model: 'claude-opus-4-6' } as SessionStatusEvent;

    const { result } = renderHook(() => useSessionStatus('s1', streamingStatus, true), {
      wrapper: createWrapper(transport),
    });

    // streamingStatus.model should be used during streaming (synchronous — no await needed)
    expect(result.current.model).toBe('claude-opus-4-6');
  });

  it('updateSession is a no-op when sessionId is null', async () => {
    // Purpose: Verify Bug A guard — when no session exists (null sessionId), updateSession
    // must silently return without calling transport.updateSession.
    const transport = createMockTransport({
      updateSession: vi.fn(),
    });

    const { result } = renderHook(() => useSessionStatus(null, null, false), {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      await result.current.updateSession({ model: 'claude-haiku-4-5-20251001' });
    });

    expect(transport.updateSession).not.toHaveBeenCalled();
  });
});
