/**
 * A transport and a query client a test can mount REAL entity hooks on.
 *
 * Entity hooks (`useConfig`, `useSessions`, `usePermissions`, …) read the
 * server through `useTransport()` inside a TanStack query. A test that fakes the
 * hook itself decides the answer AND skips the code that asks for it: the query
 * key, the transport call, the `select`, the enabled gate. Mounting the real hook
 * on a mock transport keeps all of that under test, and the only thing the test
 * decides is what the server said.
 *
 * Each harness gets its own query client, so no cached answer leaks between
 * cases.
 *
 * @module test-helpers/transport-query
 */
import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider } from '@/layers/shared/model';

/** A mounted transport and query client, plus the wrapper that provides both. */
export interface TransportQueryHarness {
  /** The mock transport the hooks under test read from. */
  transport: Transport;
  /** The query client the hooks cache into; fresh per harness. */
  queryClient: QueryClient;
  /** Wrap the component or hook under test in this. */
  Wrapper: ({ children }: { children: ReactNode }) => ReactNode;
}

/**
 * Build a mock transport and a fresh query client, and a wrapper providing both.
 *
 * @param overrides - Transport methods to answer differently from the mock
 *   defaults, typically the reads the hooks under test make.
 */
export function buildTransportQueryHarness(
  overrides: Partial<Transport> = {}
): TransportQueryHarness {
  const transport = createMockTransport(overrides);
  const queryClient = createTestQueryClient();
  return {
    transport,
    queryClient,
    Wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}
