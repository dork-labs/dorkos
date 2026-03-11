import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { App } from './App';
import { HttpTransport, QUERY_TIMING } from '@/layers/shared/lib';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import './index.css';

// Dev playground — lazy-loaded, tree-shaken from production builds
const DevPlayground = import.meta.env.DEV
  ? React.lazy(() => import('./dev/DevPlayground'))
  : null;

function DevtoolsToggle() {
  const open = useAppStore((s) => s.devtoolsOpen);
  if (!open) return null;
  // Lazy-load devtools only when toggled on
  const ReactQueryDevtools = React.lazy(() =>
    import('@tanstack/react-query-devtools').then((m) => ({ default: m.ReactQueryDevtools }))
  );
  return (
    <React.Suspense fallback={null}>
      <ReactQueryDevtools initialIsOpen />
    </React.Suspense>
  );
}

/** Root decides between the dev playground and the real app. */
function Root() {
  if (window.location.pathname.startsWith('/dev') && DevPlayground) {
    return (
      <React.Suspense fallback={null}>
        <DevPlayground />
      </React.Suspense>
    );
  }

  return (
    <NuqsAdapter>
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <App />
        </TransportProvider>
        {import.meta.env.DEV && <DevtoolsToggle />}
      </QueryClientProvider>
    </NuqsAdapter>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_TIMING.DEFAULT_STALE_TIME_MS,
      retry: QUERY_TIMING.DEFAULT_RETRY,
    },
  },
});

const transport = new HttpTransport('/api');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
