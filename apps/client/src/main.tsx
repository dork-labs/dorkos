import React from 'react';
import ReactDOM from 'react-dom/client';

// Expose React globally for extensions — they run as ESM modules
// with `react` externalized, so they reference `React.createElement` etc.
// from the global scope (Obsidian plugin model).
(globalThis as unknown as Record<string, unknown>).React = React;
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './router';
import { HttpTransport, queryClient } from '@/layers/shared/lib';
import {
  TransportProvider,
  useAppStore,
  useExtensionRegistry,
  EventStreamProvider,
} from '@/layers/shared/model';
import { PasscodeGateWrapper } from '@/layers/features/tunnel-gate';
import { ExtensionProvider } from '@/layers/features/extensions';
import type { ExtensionAPIDeps } from '@/layers/features/extensions';
import { initializeExtensions } from './app/init-extensions';
import { ErrorBoundary } from 'react-error-boundary';
import { AppCrashFallback } from '@/layers/shared/ui/app-crash-fallback';
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

  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <EventStreamProvider>
          <ExtensionProvider deps={extensionDeps}>
            <PasscodeGateWrapper>
              <RouterProvider router={router} />
            </PasscodeGateWrapper>
          </ExtensionProvider>
        </EventStreamProvider>
      </TransportProvider>
      {import.meta.env.DEV && <DevtoolsToggle />}
    </QueryClientProvider>
  );
}

// Router at module scope — creating it inside Root() caused StrictMode to
// remount the entire provider tree (including EventStreamProvider) on every
// render, producing duplicate SSE connections.
const router = createAppRouter(queryClient);

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
  // navigate is provided as a no-op here. Extensions calling navigate() after
  // mount should use the router instance directly. The no-op prevents crashes
  // if an extension calls navigate() during module initialization.
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
    'right-panel',
  ] as const) as ExtensionAPIDeps['availableSlots'],
  registerCommandHandler: (actionId: string, callback: () => void) => {
    commandHandlers.set(actionId, callback);
  },
  unregisterCommandHandler: (actionId: string) => {
    commandHandlers.delete(actionId);
  },
};

// Register all built-in features into the extension registry
initializeExtensions();

ReactDOM.createRoot(document.getElementById('root')!, {
  onCaughtError: (error, errorInfo) => {
    // Fires when an ErrorBoundary catches — fallback UI is already showing
    console.error('[dorkos:caught]', error, errorInfo.componentStack);
  },
  onUncaughtError: (error, errorInfo) => {
    // Fires when no ErrorBoundary caught it — full app crash
    console.error('[dorkos:uncaught]', error, errorInfo.componentStack);
  },
}).render(
  <React.StrictMode>
    <ErrorBoundary FallbackComponent={AppCrashFallback}>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>
);
