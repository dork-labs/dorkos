/**
 * An isolated, pre-seeded `QueryClient` for marketplace showcases, so each
 * section renders a realistic state without asking the server.
 *
 * @module dev/showcases/marketplace-query-provider
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Build an isolated QueryClient with marketplace package data pre-seeded.
 *
 * Each invocation returns a new client to ensure showcase sections are fully
 * independent. The `staleTime: Infinity` prevents background refetches that
 * would hit the server (which is not running in the playground context).
 */
function makeSeededQueryClient(seed: (qc: QueryClient) => void): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
    },
  });
  seed(qc);
  return qc;
}

/** Wrapper providing an isolated QueryClient with pre-seeded data. */
export function IsolatedQueryProvider({
  seed,
  children,
}: {
  seed: (qc: QueryClient) => void;
  children: React.ReactNode;
}) {
  // useMemo ensures the client is created once per component mount.
  const qc = useMemo(() => makeSeededQueryClient(seed), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
