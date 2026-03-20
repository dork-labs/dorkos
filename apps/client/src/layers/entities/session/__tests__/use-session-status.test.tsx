/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useSessionStatus } from '../model/use-session-status';

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
