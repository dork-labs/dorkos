/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useSessionStatus } from '../use-session-status';

// Suppress useAppStore selectedCwd selector
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

describe('useSessionStatus — null sessionId guard', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
  });

  it('does not call getSession when sessionId is null', () => {
    // Purpose: same guard pattern as useTaskState — verify no request with null.
    // This is the exact bug: GET /api/sessions//status was returning 404 because
    // ChatPanel coerced null to '' with (sessionId ?? '') before calling this hook.
    renderHook(() => useSessionStatus(null, null, false), {
      wrapper: createWrapper(mockTransport),
    });

    expect(mockTransport.getSession).not.toHaveBeenCalled();
  });

  it('returns default permissionMode when sessionId is null', () => {
    // Purpose: confirm the hook returns stable defaults when disabled,
    // so ChatPanel renders correctly without a session.
    const { result } = renderHook(() => useSessionStatus(null, null, false), {
      wrapper: createWrapper(mockTransport),
    });

    expect(result.current.permissionMode).toBe('default');
    expect(result.current.isStreaming).toBe(false);
  });

  it('updateSession is a no-op when sessionId is null', async () => {
    // Purpose: verify that calling updateSession with null sessionId does nothing,
    // since the UI should only invoke it when a session is active.
    const { result } = renderHook(() => useSessionStatus(null, null, false), {
      wrapper: createWrapper(mockTransport),
    });

    await result.current.updateSession({ model: 'claude-opus-4-5' });

    expect(mockTransport.updateSession).not.toHaveBeenCalled();
  });
});
