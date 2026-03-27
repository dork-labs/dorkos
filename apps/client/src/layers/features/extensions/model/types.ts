import type { ExtensionAPI, ExtensionModule, ExtensionManifest } from '@dorkos/extension-api';
import type { ExtensionPointId, ExtensionReadableState } from '@dorkos/extension-api';
import type { DispatcherContext } from '@/layers/shared/lib/ui-action-dispatcher';

/** A fully loaded and activated extension on the client side. */
export interface LoadedExtension {
  id: string;
  manifest: ExtensionManifest;
  module: ExtensionModule;
  api: ExtensionAPI;
  /** All unsubscribe functions collected from register* calls. */
  cleanups: Array<() => void>;
  /** Optional cleanup function returned from activate(). */
  deactivate?: () => void;
}

/** Dependencies injected into the API factory from host context. */
export interface ExtensionAPIDeps {
  /** Phase 2 registry — register contributions into slots. */
  registry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register: (slotId: string, contribution: any) => () => void;
  };
  /** Phase 1 dispatcher context for executing UI commands. */
  dispatcherContext: DispatcherContext;
  /** TanStack Router navigate function. */
  navigate: (opts: { to: string }) => void;
  /** Zustand app store for state access outside React. */
  appStore: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getState: () => any;
    subscribe: (
      selector: (state: ExtensionReadableState) => unknown,
      callback: (value: unknown) => void
    ) => () => void;
  };
  /** Set of slot IDs rendered in the current host context. */
  availableSlots: Set<ExtensionPointId>;
  /** Register a handler for a command palette action ID. */
  registerCommandHandler: (actionId: string, callback: () => void) => void;
}
