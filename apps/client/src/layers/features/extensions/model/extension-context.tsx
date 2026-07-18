import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { useEventSubscription } from '@/layers/shared/model';
import { useSyncCurrentAgentId } from '@/layers/entities/agent';
import type { LoadedExtension, ExtensionAPIDeps } from './types.js';
import { ExtensionLoader } from './extension-loader.js';
import { useCwdExtensionSync } from './use-cwd-extension-sync.js';
import { extensionKeys } from '../api/queries.js';

/** Context value exposed to the app tree. */
export interface ExtensionContextValue {
  /** All discovered extensions (from server). */
  extensions: ExtensionRecordPublic[];
  /** Currently loaded and activated extensions. */
  loaded: Map<string, LoadedExtension>;
  /** Whether the initial extension load is complete. */
  ready: boolean;
}

const defaultContextValue: ExtensionContextValue = {
  extensions: [],
  loaded: new Map(),
  ready: false,
};

const ExtensionContext = createContext<ExtensionContextValue>(defaultContextValue);

/**
 * Hook to access the extension system context.
 *
 * @returns The current extension context value: discovered extensions, loaded map, and ready flag.
 */
export function useExtensions(): ExtensionContextValue {
  return useContext(ExtensionContext);
}

interface ExtensionProviderProps {
  deps: ExtensionAPIDeps;
  children: ReactNode;
}

/**
 * Provider that loads third-party extensions on mount.
 *
 * Placement in main.tsx:
 *   QueryClientProvider
 *     → TransportProvider
 *       → ExtensionProvider        ← HERE
 *         → AuthGuard
 *           → RouterProvider
 *
 * Built-in registrations (initializeExtensions) remain synchronous and are
 * unaffected by this provider. Third-party extensions load asynchronously
 * after the initial render, so the app is interactive before extensions resolve.
 *
 * @param deps - Host primitives injected from main.tsx
 * @param children - The app subtree to wrap
 */
export function ExtensionProvider({ deps, children }: ExtensionProviderProps) {
  const [state, setState] = useState<ExtensionContextValue>(defaultContextValue);
  const loaderRef = useRef<ExtensionLoader | null>(null);
  const queryClient = useQueryClient();

  // Live-remount every extension slot for the new working directory's set.
  // reloadAll() is fetch-then-swap: it resolves the new set before tearing the
  // current one down, so a failed fetch rejects here with the previous
  // extensions still live — the rejection propagates to the cwd sync hook,
  // which owns the success/error toasts. Slot hosts watch the reactive
  // registry, so components remount cleanly without a page reload.
  const reloadAllExtensions = useCallback(async () => {
    const loader = loaderRef.current;
    if (!loader) return;

    const { extensions, loaded } = await loader.reloadAll();
    setState({ extensions, loaded, ready: true });
    // Sync TanStack Query so UI consumers of the extension list reflect the
    // cwd-scoped set immediately, not on the next poll interval.
    queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
  }, [queryClient]);

  // Watch for CWD changes and live-remount the extension slots if the set differs.
  useCwdExtensionSync(reloadAllExtensions);

  // Mirror the selected cwd's agent id into the app store so the extension host
  // can tell extensions which agent they run beside (getState().agentId).
  useSyncCurrentAgentId();

  // Initial load — store the loader in a ref so the SSE effect can access it.
  useEffect(() => {
    const loader = new ExtensionLoader(deps);
    loaderRef.current = loader;

    loader
      .initialize()
      .then(({ extensions, loaded }) => {
        setState({ extensions, loaded, ready: true });
      })
      .catch((err: unknown) => {
        console.error('[extensions] Failed to initialize:', err);
        setState((prev) => ({ ...prev, ready: true }));
      });

    return () => {
      loader.deactivateAll();
      loaderRef.current = null;
    };
    // deps is constructed once in main.tsx and is stable across re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SSE subscription for per-extension hot reload.
  // The server broadcasts `extension_reloaded` after a successful recompile.
  // We deactivate the affected extensions, re-import their bundles with a
  // cache-busted URL, reactivate them, and sync TanStack Query so any
  // consumers of useExtensions() see the refreshed server state.
  useEventSubscription('extension_reloaded', (raw) => {
    const loader = loaderRef.current;
    if (!loader) return;

    const data = raw as { extensionIds: string[]; timestamp: number };

    void (async () => {
      try {
        const { extensions, loaded } = await loader.reloadExtensions(data.extensionIds);
        setState({ extensions, loaded, ready: true });
        // Keep TanStack Query in sync so UI consumers of useExtensions() reflect
        // the refreshed status without waiting for the next poll interval.
        queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
      } catch (err) {
        console.error('[extensions] Hot reload failed:', err);
      }
    })();
  });

  return <ExtensionContext.Provider value={state}>{children}</ExtensionContext.Provider>;
}
