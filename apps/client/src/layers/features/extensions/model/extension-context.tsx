import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { LoadedExtension, ExtensionAPIDeps } from './types.js';
import { ExtensionLoader } from './extension-loader.js';
import { useCwdExtensionSync } from './use-cwd-extension-sync.js';

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
 *         → PasscodeGateWrapper
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

  // Watch for CWD changes and reload the page if the extension set differs.
  useCwdExtensionSync();

  useEffect(() => {
    const loader = new ExtensionLoader(deps);

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
    };
    // deps is constructed once in main.tsx and is stable across re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <ExtensionContext.Provider value={state}>{children}</ExtensionContext.Provider>;
}
