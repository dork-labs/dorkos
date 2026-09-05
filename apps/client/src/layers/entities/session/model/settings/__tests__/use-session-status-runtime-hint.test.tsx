/**
 * @vitest-environment jsdom
 *
 * The settings write says which runtime it is FOR.
 *
 * Before a session's first message the server has no owner recorded for it and
 * can only infer one — and model ids are runtime-namespaced, so an OpenCode
 * model judged against Claude Code's catalog is refused every time. The hook
 * already knows the answer (it is handed the same resolved runtime the chip
 * shows and the model picker was filled from), so it says it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useSessionStatus } from '../use-session-status';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd: '/test/cwd' };
      return selector ? selector(state) : state;
    },
  };
});

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function createWrapper(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useSessionStatus — the runtime hint on a settings write', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
  });

  it('sends the resolved runtime alongside the model the person picked', async () => {
    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'opencode'), {
      wrapper: createWrapper(mockTransport),
    });

    await result.current.updateSession({ model: 'openrouter/anthropic/claude-opus-4.8' });

    expect(mockTransport.updateSession).toHaveBeenCalledWith(
      SESSION_ID,
      { runtime: 'opencode', model: 'openrouter/anthropic/claude-opus-4.8' },
      '/test/cwd'
    );
  });

  it('omits the hint when the runtime is not resolved yet', async () => {
    // Nothing is claimed rather than the server default being invented here —
    // an absent hint is what makes the server decline to judge instead of
    // judging against a guess.
    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, null), {
      wrapper: createWrapper(mockTransport),
    });

    await result.current.updateSession({ model: 'sonnet' });

    expect(mockTransport.updateSession).toHaveBeenCalledWith(
      SESSION_ID,
      { model: 'sonnet' },
      '/test/cwd'
    );
  });

  it('lets an explicit runtime from the caller win', async () => {
    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'opencode'), {
      wrapper: createWrapper(mockTransport),
    });

    await result.current.updateSession({ model: 'sonnet', runtime: 'claude-code' });

    expect(mockTransport.updateSession).toHaveBeenCalledWith(
      SESSION_ID,
      { runtime: 'claude-code', model: 'sonnet' },
      '/test/cwd'
    );
  });
});
