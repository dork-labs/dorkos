// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useProvisionRuntime } from '../use-provision-runtime';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return {
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}

describe('useProvisionRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DOR-853: a 404 (no one-click install for this runtime) reads as runtime-sense, not "agent"', async () => {
    // Regression coverage for the reviewer-flagged FIX 1: this string used to
    // read "...not available for this agent." — indistinguishable from the
    // fleet sense of "agent" the D0 sweep exists to disambiguate away from.
    const transport = createMockTransport({
      provisionRuntime: vi.fn().mockResolvedValue({ ok: false, error: 'Not Found' }),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useProvisionRuntime('opencode'), { wrapper: Wrapper });

    act(() => result.current.provision());

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.errorMessage).toBe(
      'One-click install is not available for this runtime.'
    );
    expect(result.current.errorMessage).not.toMatch(/\bagent\b/i);
  });

  it('passes through an honest server error message untouched', async () => {
    const transport = createMockTransport({
      provisionRuntime: vi.fn().mockResolvedValue({ ok: false, error: 'Disk is full' }),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useProvisionRuntime('opencode'), { wrapper: Wrapper });

    act(() => result.current.provision());

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.errorMessage).toBe('Disk is full');
  });
});
