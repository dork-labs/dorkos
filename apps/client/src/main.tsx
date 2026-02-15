import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { App } from './App';
import { HttpTransport, TransportProvider, useAppStore } from '@/layers/shared/lib';
import './index.css';

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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const transport = new HttpTransport('/api');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NuqsAdapter>
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <App />
        </TransportProvider>
        {import.meta.env.DEV && <DevtoolsToggle />}
      </QueryClientProvider>
    </NuqsAdapter>
  </React.StrictMode>
);
