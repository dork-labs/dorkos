import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './router';
import { HttpTransport, QUERY_TIMING } from '@/layers/shared/lib';
import { TransportProvider, useAppStore, useExtensionRegistry } from '@/layers/shared/model';
import { PasscodeGateWrapper } from '@/layers/features/tunnel-gate';
import { ExtensionProvider } from '@/layers/features/extensions';
import type { ExtensionAPIDeps } from '@/layers/features/extensions';
import { initializeExtensions } from './app/init-extensions';
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
        <ExtensionProvider deps={extensionDeps}>
          <PasscodeGateWrapper>
            <RouterProvider router={router} />
          </PasscodeGateWrapper>
        </ExtensionProvider>
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

// Module-level map for extension command handlers registered via registerCommand().
// Keyed by actionId (`ext:<extId>:<id>`). The command palette dispatches into this map.
const commandHandlers = new Map<string, () => void>();

const extensionDeps: ExtensionAPIDeps = {
  // The registry's `register` generic signature is narrower than the `any`-based
  // ExtensionAPIDeps contract — cast to satisfy the looser interface.
  registry: useExtensionRegistry.getState() as ExtensionAPIDeps['registry'],
  dispatcherContext: {
    // AppState.setSidebarActiveTab accepts a union of literals; DispatcherStore
    // widens it to `string`. Cast to satisfy the structural interface.
    store: useAppStore.getState() as ExtensionAPIDeps['dispatcherContext']['store'],
    // Theme changes from extensions apply the class directly. A full integration
    // with useTheme requires a React ref; this covers the 'light'/'dark' subset.
    setTheme: (theme: 'light' | 'dark') => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    },
  },
  // navigate is provided as a no-op here; the router is not yet created at
  // module-init time. Extensions calling navigate() after mount will use the
  // router instance captured via closure when createAppRouter() runs in Root().
  navigate: (opts) => {
    console.warn('[extensions] navigate called before router ready:', opts);
  },
  // Zustand's subscribe overload differs from ExtensionAPIDeps' selector-based
  // subscribe shape — cast to satisfy the interface contract.
  appStore: useAppStore as unknown as ExtensionAPIDeps['appStore'],
  availableSlots: new Set([
    'sidebar.footer',
    'sidebar.tabs',
    'dashboard.sections',
    'header.actions',
    'command-palette.items',
    'dialog',
    'settings.tabs',
    'session.canvas',
  ] as const) as ExtensionAPIDeps['availableSlots'],
  registerCommandHandler: (actionId: string, callback: () => void) => {
    commandHandlers.set(actionId, callback);
  },
};

// Register all built-in features into the extension registry
initializeExtensions();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
