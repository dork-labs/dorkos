import React from 'react';
import ReactDOM from 'react-dom/client';

// Expose React globally for extensions — they run as ESM modules
// with `react` externalized, so they reference `React.createElement` etc.
// from the global scope (Obsidian plugin model).
(globalThis as unknown as Record<string, unknown>).React = React;
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './router';
import {
  HttpTransport,
  queryClient,
  streamManager,
  executeUiCommand,
  resolveApiBaseUrl,
} from '@/layers/shared/lib';
import {
  TransportProvider,
  useAppStore,
  useExtensionRegistry,
  EventStreamProvider,
} from '@/layers/shared/model';
import { AuthGuard, OwnerSetupHost } from '@/layers/features/auth';
import { ExtensionProvider, createExtensionEventBridge } from '@/layers/features/extensions';
import type { ExtensionAPIDeps } from '@/layers/features/extensions';
import { initializeExtensions } from './app/init-extensions';
import { ErrorBoundary } from 'react-error-boundary';
import { AppCrashFallback } from '@/layers/shared/ui/app-crash-fallback';
import './index.css';

// Dev playground — lazy-loaded, tree-shaken from production builds
const DevPlayground = import.meta.env.DEV ? React.lazy(() => import('./dev/DevPlayground')) : null;

// Lazy-loaded devtools panel components (tree-shaken from production builds)
const LazyQueryPanel = React.lazy(() =>
  import('@tanstack/react-query-devtools').then((m) => ({
    default: m.ReactQueryDevtoolsPanel,
  }))
);
const LazyRouterPanel = React.lazy(() =>
  import('@tanstack/react-router-devtools').then((m) => ({
    default: m.TanStackRouterDevtoolsPanel,
  }))
);

/**
 * Unified devtools panel — renders React Query and/or Router inspector
 * in a shared bottom panel with tabs, replacing the separate floating widgets.
 */
const DEFAULT_PANEL_HEIGHT = 350;
const MIN_PANEL_HEIGHT = 150;

function DevToolsPanel() {
  const devtoolsOpen = useAppStore((s) => s.devtoolsOpen);
  const routerDevtoolsOpen = useAppStore((s) => s.routerDevtoolsOpen);
  const [activeTab, setActiveTab] = React.useState<'query' | 'router'>('query');
  const [panelHeight, setPanelHeight] = React.useState(DEFAULT_PANEL_HEIGHT);
  const [isMaximized, setIsMaximized] = React.useState(false);
  const preMaxHeightRef = React.useRef(DEFAULT_PANEL_HEIGHT);

  const isOpen = devtoolsOpen || routerDevtoolsOpen;

  // Auto-switch to the tab that was just toggled on
  React.useEffect(() => {
    if (devtoolsOpen) setActiveTab('query');
  }, [devtoolsOpen]);
  React.useEffect(() => {
    if (routerDevtoolsOpen) setActiveTab('router');
  }, [routerDevtoolsOpen]);

  // Drag-to-resize handler
  const handleDragStart = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = panelHeight;

      const onMove = (ev: MouseEvent) => {
        const newH = Math.max(
          MIN_PANEL_HEIGHT,
          Math.min(window.innerHeight, startH + (startY - ev.clientY))
        );
        setPanelHeight(newH);
        setIsMaximized(false);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [panelHeight]
  );

  const toggleMaximize = React.useCallback(() => {
    if (isMaximized) {
      setPanelHeight(preMaxHeightRef.current);
      setIsMaximized(false);
    } else {
      preMaxHeightRef.current = panelHeight;
      setPanelHeight(window.innerHeight);
      setIsMaximized(true);
    }
  }, [isMaximized, panelHeight]);

  if (!isOpen) return null;

  const handleClose = () => {
    const store = useAppStore.getState();
    if (store.devtoolsOpen) store.toggleDevtools();
    if (store.routerDevtoolsOpen) store.toggleRouterDevtools();
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[9999] flex flex-col border-t border-white/10 bg-[#1e1e2e] text-white shadow-lg"
      style={{ height: panelHeight }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center bg-[#181825] hover:bg-white/5"
      >
        <div className="h-px w-8 rounded-full bg-white/20 transition-colors group-hover:bg-white/40" />
      </div>
      {/* Tab bar */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-white/10 bg-[#181825] px-1">
        <button
          onClick={() => setActiveTab('query')}
          className={`cursor-default rounded px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
            activeTab === 'query' ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80'
          }`}
        >
          React Query
        </button>
        <button
          onClick={() => setActiveTab('router')}
          className={`cursor-default rounded px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
            activeTab === 'router' ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80'
          }`}
        >
          Router
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={toggleMaximize}
            className="cursor-default rounded p-1 text-[10px] leading-none text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            aria-label={isMaximized ? 'Restore panel size' : 'Maximize panel'}
          >
            {isMaximized ? '▼' : '▲'}
          </button>
          <button
            onClick={handleClose}
            className="cursor-default rounded p-1 text-sm leading-none text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close developer tools panel"
          >
            ×
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <React.Suspense fallback={null}>
          <div className="absolute inset-0 [&>*]:h-full">
            {activeTab === 'query' && <LazyQueryPanel style={{ height: '100%' }} />}
            {activeTab === 'router' && (
              <LazyRouterPanel router={router} style={{ height: '100%' }} />
            )}
          </div>
        </React.Suspense>
      </div>
    </div>
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
            {/* AuthGuard renders the login screen when a gated request reports
                login is required (auth.enabled). It is the sole remote-access
                gate: remote visitors reach it once the exposure-guard permits a
                tunnel, so no passcode layer is needed. */}
            <AuthGuard>
              <RouterProvider router={router} />
            </AuthGuard>
            {/* Owner-setup overlay for the tunnel exposure flow (task 1.3). */}
            <OwnerSetupHost />
          </ExtensionProvider>
        </EventStreamProvider>
      </TransportProvider>
      {import.meta.env.DEV && <DevToolsPanel />}
    </QueryClientProvider>
  );
}

// Router at module scope — creating it inside Root() caused StrictMode to
// remount the entire provider tree (including EventStreamProvider) on every
// render, producing duplicate SSE connections.
const router = createAppRouter(queryClient);

// Electron serves the API on a dynamic localhost port (preload bridge); web mode
// uses the relative /api path. Shared with the auth client so both hit one origin.
const apiBaseUrl = resolveApiBaseUrl();
const transport = new HttpTransport(apiBaseUrl);
// The StreamManager's durable streams must resolve the SAME origin as the
// transport — in packaged Electron the renderer loads from file://, where a
// relative `/api` cannot reach the localhost server.
streamManager.useHttpSource(apiBaseUrl);

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
  // Curated, privacy-safe event bridge powering `api.events.subscribe`. It taps
  // the shared StreamManager (session/list/attach streams + relay broadcasts)
  // and translates them into the `ExtensionEvent` union. App-lifetime singleton
  // (singleton → singleton); never torn down.
  eventBridge: createExtensionEventBridge(streamManager),
};

// Route agent-issued UI commands (the `control_ui` MCP tool) from the active
// session's durable stream into the same dispatcher the extension API uses
// (DOR-97/DOR-104). The StreamManager gates these to the attached session, so a
// background agent can't pop UI over the foreground one. App-lifetime
// subscription (singleton → singleton); intentionally never torn down.
streamManager.subscribeUiCommand((command) =>
  executeUiCommand(extensionDeps.dispatcherContext, command)
);

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
