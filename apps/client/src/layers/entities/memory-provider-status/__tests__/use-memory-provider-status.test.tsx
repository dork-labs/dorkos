/**
 * @vitest-environment jsdom
 */
/**
 * The one aggregate the memory-provider-benched banner reads.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

import { useMemoryProviderStatus } from '../model/use-memory-provider-status';

/** A provider tree with a transport whose status read the test controls. */
function harness(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useMemoryProviderStatus', () => {
  it('is undefined until the first answer lands', () => {
    const transport = createMockTransport();
    // Never resolves within this test — the assertion is about the moment
    // before any answer arrives, not after.
    transport.getMemoryProviderStatus = () => new Promise(() => undefined);

    const { result } = renderHook(() => useMemoryProviderStatus(), {
      wrapper: harness(transport),
    });

    expect(result.current).toBeUndefined();
  });

  it('answers with the server aggregate once it resolves', async () => {
    const transport = createMockTransport();
    transport.getMemoryProviderStatus = () =>
      Promise.resolve({
        configuredId: 'acme-memory',
        activeId: 'builtin',
        benched: true,
        benchReason: 'acme is unreachable',
      });

    const { result } = renderHook(() => useMemoryProviderStatus(), {
      wrapper: harness(transport),
    });

    await waitFor(() => expect(result.current?.benched).toBe(true));
    expect(result.current).toEqual({
      configuredId: 'acme-memory',
      activeId: 'builtin',
      benched: true,
      benchReason: 'acme is unreachable',
    });
  });
});
