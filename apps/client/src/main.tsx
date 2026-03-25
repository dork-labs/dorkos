import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './router';
import { HttpTransport, QUERY_TIMING } from '@/layers/shared/lib';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { PasscodeGateWrapper } from '@/layers/features/tunnel-gate';
import './index.css';

// Dev playground — lazy-loaded, tree-shaken from production builds
const DevPlayground = import.meta.env.DEV ? React.lazy(() => import('./dev/DevPlayground')) : null;

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
  // Dev playground renders outside router (unchanged)
  if (window.location.pathname.startsWith('/dev') && DevPlayground) {
    return (
      <React.Suspense fallback={null}>
        <DevPlayground />
      </React.Suspense>
    );
  }

  const router = createAppRouter(queryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <PasscodeGateWrapper>
          <RouterProvider router={router} />
        </PasscodeGateWrapper>
      </TransportProvider>
      {import.meta.env.DEV && <DevtoolsToggle />}
    </QueryClientProvider>
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

/**
 * Detect Electron environment and resolve the API base URL.
 * In Electron, the server runs on a dynamic localhost port exposed via preload.
 * In web mode, use the relative /api path (proxied by Vite or served directly).
 */
function getApiBaseUrl(): string {
  if (window.electronAPI?.getServerPort) {
    const port = window.electronAPI.getServerPort();
    return `http://localhost:${port}/api`;
  }
  return '/api';
}

const transport = new HttpTransport(getApiBaseUrl());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
