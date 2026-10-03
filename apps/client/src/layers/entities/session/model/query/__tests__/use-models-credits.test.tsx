/**
 * @vitest-environment jsdom
 *
 * Who pays decides the model menu (DOR-2636): a session-scoped read carries the
 * person's pick of account for that session and the folder it runs in, so the
 * server can answer with the models DorkOS credits serve; a read with no
 * session carries an account only when its caller names one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useModels } from '../use-models';

const store = vi.hoisted(() => ({
  pendingAccount: null as { id: string; sessionId: string } | null,
}));
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd: '/work/project', pendingAccount: store.pendingAccount };
      return selector ? selector(state) : state;
    },
  };
});

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function wrapper(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useModels — who pays decides the menu', () => {
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    store.pendingAccount = null;
    transport = createMockTransport();
  });

  it('carries this session’s pick of DorkOS credits, and the folder it runs in', async () => {
    store.pendingAccount = { id: 'dorkos-credits', sessionId: SESSION };
    renderHook(() => useModels({ sessionId: SESSION, runtime: 'claude-code' }), {
      wrapper: wrapper(transport),
    });
    await waitFor(() =>
      expect(transport.getModels).toHaveBeenCalledWith({
        sessionId: SESSION,
        runtime: 'claude-code',
        account: 'dorkos-credits',
        cwd: '/work/project',
      })
    );
  });

  it('never carries a pick made for another session', async () => {
    store.pendingAccount = { id: 'dorkos-credits', sessionId: OTHER };
    renderHook(() => useModels({ sessionId: SESSION, runtime: 'claude-code' }), {
      wrapper: wrapper(transport),
    });
    await waitFor(() => expect(transport.getModels).toHaveBeenCalled());
    expect(vi.mocked(transport.getModels).mock.calls[0]![0]).toMatchObject({ account: undefined });
  });

  it('asks about credits with no session only when the caller says so', async () => {
    store.pendingAccount = { id: 'dorkos-credits', sessionId: SESSION };
    renderHook(() => useModels({ runtime: 'claude-code', account: 'dorkos-credits' }), {
      wrapper: wrapper(transport),
    });
    renderHook(() => useModels({ runtime: 'claude-code' }), { wrapper: wrapper(transport) });
    await waitFor(() => expect(transport.getModels).toHaveBeenCalledTimes(2));
    expect(transport.getModels).toHaveBeenCalledWith({
      sessionId: undefined,
      runtime: 'claude-code',
      account: 'dorkos-credits',
      cwd: undefined,
    });
    // The runtime-wide menu stays every sign-in's: no pick, no folder.
    expect(transport.getModels).toHaveBeenCalledWith({
      sessionId: undefined,
      runtime: 'claude-code',
      account: undefined,
      cwd: undefined,
    });
  });
});
