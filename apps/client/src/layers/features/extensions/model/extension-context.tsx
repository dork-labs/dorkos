import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import {
  getExtensionLoadAdmission,
  subscribeExtensionLoadAdmission,
  registerExtensionLoadOwner,
  markExtensionRetirementFailed,
  type ExtensionLoadAdmission,
} from '@/layers/shared/lib';
import { useEventSubscription } from '@/layers/shared/model';
import { useSyncRequireLogin } from './use-sync-require-login';
import { useSyncCurrentAgentId, useReconcileExplicitAgentPath } from '@/layers/entities/agent';
import { useCurrentProjectSync } from '@/layers/entities/project';
import type { LoadedExtension, ExtensionAPIDeps } from './types.js';
import { ExtensionLoader, type ExtensionLoadOutcome } from './extension-loader.js';
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
  /**
   * Whether a reload is swapping the loaded set right now (a working-folder
   * change, or a hot reload). In between, an extension's contributions are
   * torn down and not yet back, so a surface that would otherwise say "this
   * extension has no such page" should wait instead.
   */
  settling: boolean;
}

const defaultContextValue: ExtensionContextValue = {
  extensions: [],
  loaded: new Map(),
  ready: false,
  settling: false,
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
  const [state, setState] = useState<Publication>({ admission: null, value: defaultContextValue });
  const admission = useSyncExternalStore(
    subscribeExtensionLoadAdmission,
    getExtensionLoadAdmission,
    getExtensionLoadAdmission
  );
  const ownerRef = useRef<ProviderOwner | null>(null);
  const actions = useOwnerActions(ownerRef, setState);
  useCwdExtensionSync(actions.reload, actions.isOutcomeCurrent);
  useSyncCurrentAgentId();
  useSyncRequireLogin();
  useCurrentProjectSync();
  useReconcileExplicitAgentPath();
  useOwnerMount({ deps, admission, ownerRef, actions });
  useEventSubscription('extension_reloaded', (raw) => {
    const owner = ownerRef.current;
    if (!owner || !currentOwner(ownerRef, owner)) return;
    const data = raw as { extensionIds: string[]; timestamp: number };
    void reloadOwnedExtensions(ownerRef, owner, data.extensionIds, actions);
  });
  const value =
    state.admission === admission && !admission.suspended && !admission.retirementFailed
      ? state.value
      : defaultContextValue;
  return <ExtensionContext.Provider value={value}>{children}</ExtensionContext.Provider>;
}
type ProviderOwner = {
  identity: object;
  loader: ExtensionLoader;
  admission: ExtensionLoadAdmission;
};
type Publication = { admission: ExtensionLoadAdmission | null; value: ExtensionContextValue };
type OwnerRef = { current: ProviderOwner | null };
type Publish = (update: (previous: Publication) => Publication) => void;
function currentOwner(ref: OwnerRef, owner: ProviderOwner): boolean {
  const snapshot = getExtensionLoadAdmission();
  return (
    ref.current === owner &&
    snapshot === owner.admission &&
    !snapshot.suspended &&
    !snapshot.retirementFailed
  );
}
function publishOutcome(
  ref: OwnerRef,
  owner: ProviderOwner,
  publish: Publish,
  outcome: ExtensionLoadOutcome
): void {
  if (!currentOwner(ref, owner) || !owner.loader.isOutcomeCurrent(outcome)) return;
  publish((previous) =>
    currentOwner(ref, owner) && owner.loader.isOutcomeCurrent(outcome)
      ? {
          admission: owner.admission,
          value: {
            extensions: outcome.extensions,
            loaded: outcome.loaded,
            ready: true,
            settling: false,
          },
        }
      : previous
  );
}
function publishSettling(ref: OwnerRef, owner: ProviderOwner, publish: Publish): void {
  publish((previous) =>
    currentOwner(ref, owner)
      ? { admission: owner.admission, value: { ...previous.value, settling: true } }
      : previous
  );
}
function useOwnerActions(ref: OwnerRef, publish: Publish) {
  const query = useQueryClient();
  const outcomes = useRef(new WeakMap<ExtensionLoadOutcome, ProviderOwner>());
  const reload = useCallback(async () => {
    const owner = ref.current;
    if (!owner || !currentOwner(ref, owner)) return;
    publishSettling(ref, owner, publish);
    try {
      const outcome = await owner.loader.reloadAll();
      if (!currentOwner(ref, owner) || !owner.loader.isOutcomeCurrent(outcome)) return;
      publishOutcome(ref, owner, publish, outcome);
      outcomes.current.set(outcome, owner);
      if (outcome.status === 'completed') refreshList(ref, owner, query);
      return outcome;
    } catch {
      return undefined;
    } // An unbound rejection grants no settling/query publication.
  }, [ref, publish, query]);
  const isOutcomeCurrent = useCallback(
    (outcome: ExtensionLoadOutcome) => {
      const owner = outcomes.current.get(outcome);
      return !!owner && currentOwner(ref, owner) && owner.loader.isOutcomeCurrent(outcome);
    },
    [ref]
  );
  return { reload, isOutcomeCurrent, publish, query };
}
type OwnerActions = ReturnType<typeof useOwnerActions>;
function refreshList(
  ref: OwnerRef,
  owner: ProviderOwner,
  query: ReturnType<typeof useQueryClient>
): void {
  const method = query.invalidateQueries;
  const request = { queryKey: extensionKeys.lists() };
  if (!currentOwner(ref, owner)) return;
  void Reflect.apply(method, query, [request]).catch(() => {
    /* Cache refresh failure grants no new load outcome. */
  });
}
function useOwnerMount(input: {
  deps: ExtensionAPIDeps;
  admission: ExtensionLoadAdmission;
  ownerRef: OwnerRef;
  actions: OwnerActions;
}): void {
  const {
    deps,
    admission,
    ownerRef,
    actions: { reload, isOutcomeCurrent, publish },
  } = input;
  useEffect(() => {
    if (
      admission.suspended ||
      admission.retirementFailed ||
      getExtensionLoadAdmission() !== admission
    )
      return;
    const identity = {};
    const owner = {
      identity,
      loader: new ExtensionLoader(deps, admission, () => markExtensionRetirementFailed(identity)),
      admission,
    };
    ownerRef.current = owner;
    const retire = () => {
      if (ownerRef.current === owner) ownerRef.current = null;
      return owner.loader.deactivateAll();
    };
    const unregister = registerExtensionLoadOwner(identity, admission, retire, async () => {
      const outcome = await reload();
      if (outcome && isOutcomeCurrent(outcome) && outcome.status !== 'completed')
        throw new Error('Extensions could not be refreshed.');
    });
    if (!currentOwner(ownerRef, owner)) {
      unregister();
      retire();
      return;
    }
    void owner.loader
      .initialize()
      .then((outcome) => publishOutcome(ownerRef, owner, publish, outcome))
      .catch(() => {
        /* Unexpected unbound rejection publishes no state; ordinary failures are bound outcomes. */
      });
    return () => {
      unregister();
      if (!retire()) markExtensionRetirementFailed(identity);
    };
  }, [deps, admission, ownerRef, reload, isOutcomeCurrent, publish]);
}
async function reloadOwnedExtensions(
  ref: OwnerRef,
  owner: ProviderOwner,
  ids: string[],
  actions: OwnerActions
): Promise<void> {
  if (!currentOwner(ref, owner)) return;
  publishSettling(ref, owner, actions.publish);
  try {
    const outcome = await owner.loader.reloadExtensions(ids);
    if (!currentOwner(ref, owner) || !owner.loader.isOutcomeCurrent(outcome)) return;
    publishOutcome(ref, owner, actions.publish, outcome);
    if (outcome.status === 'completed') refreshList(ref, owner, actions.query);
  } catch {
    /* Unexpected rejection has no genuine outcome; never erase a newer settling turn. */
  }
}
