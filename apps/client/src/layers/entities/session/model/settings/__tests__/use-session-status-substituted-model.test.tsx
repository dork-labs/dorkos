/**
 * @vitest-environment jsdom
 *
 * The status line shows the model a turn really ran on (DOR-2636): when DorkOS
 * credits ran another model than the session named, the stream's notice says
 * which, before the session's own record is read again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockSession, createMockTransport } from '@dorkos/test-utils';
import { useSessionStatus } from '../use-session-status';
import {
  useSessionStreamStore,
  DEFAULT_SESSION_STREAM_STATE,
} from '../../stream/session-stream-store';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd: '/test/cwd', pendingAccount: null };
      return selector ? selector(state) : state;
    },
  };
});

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function wrapper(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function withHistoryNotice(from: string, to: string) {
  useSessionStreamStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [SESSION_ID]: {
        ...DEFAULT_SESSION_STREAM_STATE,
        messages: [
          {
            id: 'model-substituted-3',
            role: 'assistant',
            content: '',
            parts: [
              {
                type: 'model_substituted',
                from,
                fromName: 'Opus',
                to,
                toName: 'Suggested',
                reason: 'credits-not-covered',
              },
            ],
          },
        ],
      },
    },
  }));
}

describe('useSessionStatus — the model a turn ran on', () => {
  beforeEach(() => {
    useSessionStreamStore.setState((state) => ({ ...state, sessions: {} }));
  });

  it('shows the model credits ran in place of the one the session named', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue(createMockSession({ id: SESSION_ID, model: 'opus' })),
    });
    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: wrapper(transport),
    });
    await waitFor(() => expect(result.current.model).toBe('opus'));
    act(() => withHistoryNotice('opus', 'md_suggested'));
    await waitFor(() => expect(result.current.model).toBe('md_suggested'));
  });

  it('keeps a model the person picked since, whatever an older notice says', async () => {
    withHistoryNotice('opus', 'md_suggested');
    const transport = createMockTransport({
      getSession: vi
        .fn()
        .mockResolvedValue(createMockSession({ id: SESSION_ID, model: 'md_other' })),
    });
    const { result } = renderHook(() => useSessionStatus(SESSION_ID, null, false, 'claude-code'), {
      wrapper: wrapper(transport),
    });
    await waitFor(() => expect(result.current.model).toBe('md_other'));
  });
});
